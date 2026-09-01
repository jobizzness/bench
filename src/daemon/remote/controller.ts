import { hostname, platform as osPlatform } from "node:os";
import {
  clearIdentity, loadIdentity, mintMachineId, saveIdentity, type RemoteIdentity,
} from "./identity-file.js";
import { RefreshRejected, Refresher } from "./token-refresh.js";
import { firestoreClient, type FirestoreClient } from "./firestore-rest.js";
import { deregisterMachine, heartbeat, registerMachine } from "./machine.js";
import { RemoteBridge } from "./bridge.js";
import type { LocalCaller } from "./command-runner.js";
import type { RosterRow } from "../../shared/types.js";
import type { RemoteState } from "../../shared/remote.js";

export type { RemoteState } from "../../shared/remote.js";

/** How often the daemon touches `lastSeen` while remote is on. Cheap - one
 * write - and frequent enough that a phone checking "is this laptop awake"
 * gets an answer inside a couple of minutes. */
const HEARTBEAT_MS = 90_000;

export interface RemoteControllerLike {
  state(): RemoteState;
  connect(refreshToken: string, uid: string, email?: string): Promise<RemoteState>;
  disconnect(): Promise<RemoteState>;
  renameMachine(name: string): Promise<RemoteState>;
}

export interface RemoteControllerOptions {
  home: string;
  apiKey: string;
  projectId: string;
  version: string;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  /** For tests: the machine name and platform this "laptop" reports as. */
  hostname?: string;
  platform?: string;
  /** The roster, filtered to broadcast - what `RemoteBridge` is allowed to
   * mirror. Absent leaves remote holding an identity but never wiring the
   * bridge, which is what every existing test that does not care about #46
   * gets by not passing it. */
  listBroadcast?: () => RosterRow[];
  /** Runs a command against this daemon's own HTTP server, on loopback, with
   * its own token - see "Routing back through the daemon's own HTTP server"
   * in the design. Required alongside `listBroadcast` for the bridge to run;
   * either alone is a daemon that can hold an identity but never carries
   * remote traffic. */
  callLocal?: LocalCaller;
  bridgeOpts?: {
    viewerPollMs?: number;
    tickMs?: number;
    now?: () => number;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
  };
}

/**
 * Everything this ticket adds up to: one Google identity, held across
 * restarts, kept fresh, and announced as one machine document.
 *
 * Composed once in `index.ts` and handed to the server - the routes in
 * `server.ts` only ever call these four methods, never the modules
 * underneath directly, so the state machine (connected, mid-refresh, revoked)
 * lives in exactly one place.
 */
export class RemoteController implements RemoteControllerLike {
  private identity: RemoteIdentity | null = null;
  private refresher: Refresher | null = null;
  private client: FirestoreClient | null = null;
  private machineName: string | null = null;
  private error: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private bridge: RemoteBridge | null = null;

  private readonly hostnameValue: string;
  private readonly platformValue: string;

  constructor(private opts: RemoteControllerOptions) {
    this.hostnameValue = opts.hostname ?? hostname();
    this.platformValue = opts.platform ?? osPlatform();
  }

  state(): RemoteState {
    return {
      connected: this.refresher !== null && this.error === null,
      uid: this.identity?.uid ?? null,
      email: this.identity?.email ?? null,
      machineId: this.identity?.machineId ?? null,
      machineName: this.machineName,
      platform: this.identity ? this.platformValue : null,
      tokenExpiresAt: this.refresher?.expiresAt() ?? null,
      error: this.error,
    };
  }

  /** Read the identity file, if there is one, and resume as it - called once
   * at daemon boot. Does not throw: a dead or missing credential just leaves
   * remote off, the same as if it had never been turned on. */
  async resume(): Promise<void> {
    const identity = loadIdentity(this.opts.home);
    if (identity === null) return;
    try {
      await this.establish(identity);
    } catch (error) {
      this.error = describeFailure(error);
    }
  }

  async connect(refreshToken: string, uid: string, email?: string): Promise<RemoteState> {
    // Reusing the machine id already on file for this uid is what makes a
    // restart, not a re-sign-in that happens to answer the same question,
    // fail to mint a second machine - see the acceptance criterion for it.
    const onFile = loadIdentity(this.opts.home);
    const machineId = onFile?.uid === uid ? onFile.machineId : mintMachineId();

    await this.establish({ uid, refreshToken, machineId, ...(email ? { email } : {}) });
    return this.state();
  }

  async disconnect(): Promise<RemoteState> {
    if (this.identity && this.client) {
      try {
        // `bench remote off` per the design: the machine's whole subtree,
        // not only its own document. Before deregistering the machine
        // itself, since `wipe()` addresses paths under it.
        await this.bridge?.wipe();
        await deregisterMachine(this.client, this.identity.uid, this.identity.machineId);
      } catch {
        // The local side of "off" still has to happen even if the network
        // does not cooperate - a machine document nobody can reach is not
        // worse than one that outlives the account that owned it.
      }
    }
    this.teardown();
    clearIdentity(this.opts.home);
    return this.state();
  }

  async renameMachine(name: string): Promise<RemoteState> {
    if (this.identity === null || this.client === null) {
      throw new Error("remote is not on");
    }
    this.machineName = name;
    await heartbeat(this.client, this.identity.uid, this.identity.machineId, name, this.platformValue, this.opts.version);
    return this.state();
  }

  /** Stop the refresher and the heartbeat, in memory only - used both by a
   * deliberate disconnect and by a revoked refresh token, which needs the
   * same cleanup without touching the file (there is nothing on disk worth
   * saving from a dead token, but a revocation is not "forget me", so it
   * leaves the file for a diagnostic and lets the next sign-in overwrite it). */
  private teardown(): void {
    this.refresher?.stop();
    this.refresher = null;
    this.client = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.bridge?.stop();
    this.bridge = null;
    this.identity = null;
    this.machineName = null;
  }

  private async establish(identity: RemoteIdentity): Promise<void> {
    // A second `connect()` while already on - reconnecting the same account,
    // or a stray double click - must not leave the previous refresher and
    // heartbeat running behind the new one.
    this.teardown();

    const refresher = new Refresher({
      apiKey: this.opts.apiKey,
      fetchImpl: this.opts.fetchImpl,
      onRotated: (refreshToken) => {
        this.identity = { ...identity, refreshToken };
        saveIdentity(this.opts.home, this.identity);
      },
      onRejected: (rejected) => {
        this.error = describeFailure(rejected);
        this.teardown();
      },
    });

    // Thrown here - the initial exchange - is the caller's problem: a
    // `connect()` with a bad refresh token should answer the HTTP request
    // with a 400, not silently leave remote half-on.
    await refresher.start(identity.refreshToken);

    this.error = null;
    this.identity = identity;
    this.refresher = refresher;
    this.client = firestoreClient({
      projectId: this.opts.projectId,
      idToken: () => refresher.idToken(),
      fetchImpl: this.opts.fetchImpl,
    });

    // Both have to be supplied for the bridge to run at all - a daemon can
    // hold an identity with neither wired up (every test that predates #46,
    // and any caller that only wants the identity slice from #45).
    if (this.opts.listBroadcast && this.opts.callLocal) {
      this.bridge = new RemoteBridge({
        client: this.client,
        uid: identity.uid,
        machineId: identity.machineId,
        listBroadcast: this.opts.listBroadcast,
        callLocal: this.opts.callLocal,
        ...this.opts.bridgeOpts,
      });
      this.bridge.start();
    }

    saveIdentity(this.opts.home, identity);

    try {
      // A rename that happened before this restart is still the name the
      // developer chose - read it back rather than stamping the hostname
      // over it on every reconnect.
      const existing = await this.client.get(`users/${identity.uid}/machines/${identity.machineId}`);
      this.machineName = typeof existing?.name === "string" ? existing.name : this.hostnameValue;
      await registerMachine(this.client, identity.uid, identity.machineId, {
        name: this.machineName,
        platform: this.platformValue,
        version: this.opts.version,
        lastSeen: Date.now(),
      });
    } catch (error) {
      // The ID token is good - refresher.start() above already proved that -
      // so this is only the bookkeeping write failing to land, not a reason
      // to call remote off. The heartbeat retries on its own schedule and
      // catches the machine document up once Firestore is reachable again.
      this.machineName ??= this.hostnameValue;
      process.stderr.write(`bench: could not register this machine yet: ${String(error)}\n`);
    }

    const interval = this.opts.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => { void this.beat(); }, interval);
    this.heartbeatTimer.unref?.();

    process.stdout.write(
      `bench: remote connected as ${identity.uid.slice(0, 8)}…, `
      + `machine ${identity.machineId.slice(0, 8)}…, `
      + `token expires ${new Date(refresher.expiresAt()!).toISOString()}\n`,
    );
  }

  private async beat(): Promise<void> {
    if (this.identity === null || this.client === null || this.machineName === null) return;
    try {
      await heartbeat(this.client, this.identity.uid, this.identity.machineId, this.machineName, this.platformValue, this.opts.version);
    } catch {
      // A missed heartbeat is not remote going off - the refresher is the
      // thing that decides that, and it has its own retry.
    }
  }
}

/** Only a dead refresh token is "sign in again" - anything else reaching
 * here is a network or Firestore failure during the initial exchange, which
 * is worth naming but not the same claim. */
function describeFailure(error: unknown): string {
  if (error instanceof RefreshRejected) return "remote is off, sign in again";
  return `remote could not connect: ${String(error instanceof Error ? error.message : error)}`;
}
