import * as grpc from "@grpc/grpc-js";
import type { DecodedDoc } from "./firestore-rest.js";
import {
  decodeListenResponse, encodeListenRequest, TargetChangeType,
  type ListenResponse, type ListenTarget,
} from "./listen-proto.js";

/**
 * A push listener for the daemon, over Firestore's own `Listen` RPC.
 *
 * The bridge used to poll because the Firestore client SDK cannot be signed
 * in from a bare refresh token (see `bridge.ts`). It does not need to be: the
 * `Listen` RPC is the same streaming call the SDK makes underneath, and it
 * takes the same `Authorization: Bearer <Firebase ID token>` the REST client
 * in `firestore-rest.ts` already sends, admitted by the same rules. One
 * long-lived stream per machine watches the presence document and the
 * `commands` collection, and Firestore bills a read per document that
 * *changes* - not one per poll to confirm nothing did. A command lands on the
 * daemon in well under a second instead of on the next 2s tick, or the next
 * 60s idle poll.
 *
 * Reconnects on its own, with backoff, carrying each target's resume token so
 * a reconnect inside Firestore's resume window is not billed for documents it
 * has already seen. While it is not `healthy()`, the bridge falls back to the
 * polling it always did - so a network that blocks HTTP/2, or a project where
 * the stream is refused, degrades to the old behaviour rather than to none.
 */

export interface ListenerTargetSpec {
  /** Caller's name for this target - what `onChange` and `docs()` are keyed by. */
  key: string;
  /** A document path (`users/u/machines/m/presence/state`) or a collection
   * path (`users/u/machines/m/commands`), relative to `documents/`. */
  path: string;
  kind: "document" | "collection";
}

export interface ListenedDoc {
  /** The last path segment - the same `id` `firestoreClient.list` gives. */
  id: string;
  data: DecodedDoc;
}

export interface RemoteListener {
  start(): void;
  stop(): void;
  /** True once every target has reached CURRENT on the open stream, and
   * nothing has gone wrong since - the cached documents are exactly what
   * Firestore holds, and the bridge may skip polling. */
  healthy(): boolean;
  docs(key: string): ListenedDoc[];
  /** Restart the stream if the ID token has moved on since it was opened.
   * Cheap to call often: a string comparison unless the token rotated. */
  refreshAuth(): void;
}

export interface FirestoreListenerOptions {
  projectId: string;
  idToken: () => string | null;
  targets: ListenerTargetSpec[];
  /** A target's documents changed and the stream is consistent - called
   * once per consistent snapshot per changed target. */
  onChange: (key: string) => void;
  /** Called once when the stream stops being healthy and once when it
   * becomes healthy again, never on every retry. */
  warn?: (message: string) => void;
  /** `host:port`. Defaults to production. The emulator is plaintext. */
  endpoint?: string;
  insecure?: boolean;
  /** For tests: a stand-in for the gRPC call. */
  openStream?: (metadata: grpc.Metadata) => ListenStream;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/** The slice of a gRPC duplex call the listener uses. */
export interface ListenStream {
  write(message: Buffer): void;
  end(): void;
  cancel(): void;
  on(event: "data", fn: (message: Buffer) => void): this;
  on(event: "error", fn: (error: Error & { code?: number }) => void): this;
  on(event: "end", fn: () => void): this;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** gRPC status codes worth naming in a log line. */
const UNAUTHENTICATED = 16;
const PERMISSION_DENIED = 7;

interface TargetState {
  spec: ListenerTargetSpec;
  id: number;
  resumeToken: Buffer | null;
  docs: Map<string, DecodedDoc>;
  current: boolean;
  dirty: boolean;
}

export class FirestoreListener implements RemoteListener {
  private readonly database: string;
  private readonly prefix: string;
  private readonly targets: TargetState[];
  private readonly byId = new Map<number, TargetState>();
  private client: grpc.Client | null = null;
  private stream: ListenStream | null = null;
  private streamToken: string | null = null;
  private running = false;
  private backoffMs = MIN_BACKOFF_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wasHealthy = false;
  private healthySince = 0;
  private reportedFailure = false;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(private readonly opts: FirestoreListenerOptions) {
    this.database = `projects/${opts.projectId}/databases/(default)`;
    this.prefix = `${this.database}/documents/`;
    this.targets = opts.targets.map((spec, i) => ({
      spec, id: i + 1, resumeToken: null, docs: new Map(), current: false, dirty: false,
    }));
    for (const t of this.targets) this.byId.set(t.id, t);
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) this.clearTimeoutImpl(this.retryTimer);
    this.retryTimer = null;
    this.closeStream();
    this.client?.close();
    this.client = null;
    for (const t of this.targets) {
      t.current = false;
      t.docs.clear();
      t.resumeToken = null;
    }
    this.wasHealthy = false;
  }

  healthy(): boolean {
    return this.running && this.stream !== null && this.targets.every((t) => t.current);
  }

  docs(key: string): ListenedDoc[] {
    const target = this.targets.find((t) => t.spec.key === key);
    if (!target) return [];
    return [...target.docs].map(([name, data]) => ({ id: name.slice(name.lastIndexOf("/") + 1), data }));
  }

  refreshAuth(): void {
    if (!this.running || this.stream === null) return;
    const token = this.opts.idToken();
    if (token !== null && token !== this.streamToken) this.restart();
  }

  // ------------------------------------------------------------ the stream

  private open(): void {
    if (!this.running) return;
    const token = this.opts.idToken();
    if (token === null) { this.scheduleRetry(new Error("no ID token yet")); return; }

    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${token}`);
    // Both are what Google's own clients send; the second is what routes the
    // call to the right database.
    metadata.set("google-cloud-resource-prefix", this.database);
    metadata.set("x-goog-request-params", `database=${encodeURIComponent(this.database)}`);

    let stream: ListenStream;
    try {
      stream = this.opts.openStream ? this.opts.openStream(metadata) : this.grpcStream(metadata);
    } catch (error) {
      this.scheduleRetry(error);
      return;
    }
    this.stream = stream;
    this.streamToken = token;

    stream.on("data", (message: Buffer) => {
      if (this.stream !== stream) return;
      try {
        this.handle(decodeListenResponse(message));
      } catch (error) {
        this.fail(stream, error);
      }
    });
    stream.on("error", (error) => { this.fail(stream, error); });
    stream.on("end", () => { this.fail(stream, new Error("stream ended")); });

    for (const t of this.targets) {
      t.current = false;
      // Without a token the server sends every document again from scratch,
      // so whatever was cached must go or a document deleted while we were
      // away would linger here forever.
      if (t.resumeToken === null) t.docs.clear();
      stream.write(encodeListenRequest(this.database, {
        add: {
          targetId: t.id,
          target: this.wireTarget(t.spec),
          ...(t.resumeToken ? { resumeToken: t.resumeToken } : {}),
        },
      }));
    }
  }

  private grpcStream(metadata: grpc.Metadata): ListenStream {
    if (this.client === null) {
      const endpoint = this.opts.endpoint ?? "firestore.googleapis.com:443";
      const credentials = this.opts.insecure ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
      this.client = new grpc.Client(endpoint, credentials, {
        // A laptop that sleeps leaves a half-open connection behind; pings
        // are what notice it on wake rather than a stream that never speaks
        // again. Two minutes is well inside what Google's frontends accept.
        "grpc.keepalive_time_ms": 120_000,
        "grpc.keepalive_timeout_ms": 20_000,
      });
    }
    const passthrough = (b: Buffer) => b;
    return this.client.makeBidiStreamRequest<Buffer, Buffer>(
      "/google.firestore.v1.Firestore/Listen", passthrough, passthrough, metadata,
    ) as unknown as ListenStream;
  }

  private wireTarget(spec: ListenerTargetSpec): ListenTarget {
    if (spec.kind === "document") return { kind: "document", name: this.prefix + spec.path };
    const slash = spec.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : spec.path.slice(0, slash);
    return {
      kind: "collection",
      parent: parentPath === "" ? this.prefix.slice(0, -1) : this.prefix + parentPath,
      collectionId: spec.path.slice(slash + 1),
    };
  }

  private handle(msg: ListenResponse): void {
    switch (msg.kind) {
      case "documentChange": {
        for (const id of msg.targetIds) this.byId.get(id)?.docs.set(msg.document.name, msg.document.data);
        for (const id of msg.removedTargetIds) this.byId.get(id)?.docs.delete(msg.document.name);
        for (const id of [...msg.targetIds, ...msg.removedTargetIds]) this.markDirty(id);
        return;
      }
      case "documentDelete":
      case "documentRemove": {
        const ids = msg.removedTargetIds.length > 0 ? msg.removedTargetIds : this.targets.map((t) => t.id);
        for (const id of ids) {
          if (this.byId.get(id)?.docs.delete(msg.name)) this.markDirty(id);
        }
        return;
      }
      case "filter": {
        // The server's count disagrees with ours - something was deleted
        // that we never heard about. Drop what we have for that target and
        // listen again from scratch rather than trust a cache we know is off.
        const target = this.byId.get(msg.targetId);
        if (target && target.docs.size !== msg.count) {
          target.resumeToken = null;
          this.restart();
        }
        return;
      }
      case "targetChange":
        this.handleTargetChange(msg);
        return;
      case "unknown":
        return;
    }
  }

  private handleTargetChange(msg: Extract<ListenResponse, { kind: "targetChange" }>): void {
    const affected = msg.targetIds.length > 0
      ? msg.targetIds.map((id) => this.byId.get(id)).filter((t): t is TargetState => t !== undefined)
      : this.targets;

    if (msg.type === TargetChangeType.REMOVE) {
      const cause = msg.cause ? `${msg.cause.code} ${msg.cause.message}` : "no cause given";
      throw Object.assign(new Error(`target removed by server: ${cause}`), { code: msg.cause?.code });
    }
    if (msg.type === TargetChangeType.RESET) {
      for (const t of affected) { t.docs.clear(); t.current = false; t.dirty = true; }
      return;
    }
    if (msg.type === TargetChangeType.CURRENT) {
      for (const t of affected) t.current = true;
    }
    if (msg.resumeToken && msg.resumeToken.length > 0) {
      for (const t of affected) t.resumeToken = msg.resumeToken;
    }

    // A global NO_CHANGE (no target ids) with a resume token is Firestore's
    // "everything up to here is consistent" - the moment a snapshot may be
    // handed to a reader. CURRENT is the same claim for a target's first one.
    const consistent = msg.type === TargetChangeType.CURRENT
      || (msg.type === TargetChangeType.NO_CHANGE && msg.targetIds.length === 0);
    if (!consistent || !this.healthy()) return;

    if (!this.wasHealthy) {
      this.wasHealthy = true;
      this.healthySince = Date.now();
      if (this.reportedFailure) {
        this.reportedFailure = false;
        this.opts.warn?.("bench: remote listener connected again\n");
      }
      // First consistent snapshot on this stream: everything is news.
      for (const t of this.targets) t.dirty = true;
    }
    for (const t of this.targets) {
      if (!t.dirty) continue;
      t.dirty = false;
      this.opts.onChange(t.spec.key);
    }
  }

  private markDirty(id: number): void {
    const t = this.byId.get(id);
    if (t) t.dirty = true;
  }

  private fail(stream: ListenStream, error: unknown): void {
    if (this.stream !== stream) return;
    // Only a stream that stayed up a while earns the quiet reconnect - one
    // that keeps dropping right after it connects should back off like any
    // other failure rather than reconnect in a loop.
    const wasHealthy = this.wasHealthy && Date.now() - this.healthySince > 10_000;
    this.closeStream();
    if (wasHealthy) {
      // A stream that was working and then closed is ordinary - Firestore
      // rotates long-lived streams, and an expiring token ends one too.
      // Reconnect at once, quietly, with the resume tokens in hand; only a
      // stream that never gets healthy is worth a log line and a backoff.
      this.backoffMs = MIN_BACKOFF_MS;
      this.retryTimer = this.setTimeoutImpl(() => { this.retryTimer = null; this.open(); }, 0);
      (this.retryTimer as unknown as { unref?: () => void }).unref?.();
      return;
    }
    this.scheduleRetry(error);
  }

  private restart(): void {
    this.closeStream();
    this.open();
  }

  private closeStream(): void {
    const stream = this.stream;
    this.stream = null;
    this.streamToken = null;
    this.wasHealthy = false;
    for (const t of this.targets) t.current = false;
    if (stream) {
      try { stream.cancel(); } catch { /* already closed */ }
    }
  }

  private scheduleRetry(error: unknown): void {
    if (!this.running || this.retryTimer) return;
    if (!this.reportedFailure) {
      this.reportedFailure = true;
      this.opts.warn?.(`bench: remote listener unavailable, polling until it reconnects: ${describe(error)}\n`);
    }
    const code = (error as { code?: number } | null)?.code;
    // A refused credential will not fix itself in a second - and a token
    // about to be refreshed is exactly the case where waiting helps.
    const floor = code === UNAUTHENTICATED || code === PERMISSION_DENIED ? 15_000 : 0;
    const delay = Math.max(floor, this.backoffMs) * (0.8 + Math.random() * 0.4);
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.retryTimer = this.setTimeoutImpl(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: number }).code;
    return code === undefined ? error.message : `${error.message} (code ${code})`;
  }
  return String(error);
}
