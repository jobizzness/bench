import type { FirestoreClient } from "./firestore-rest.js";
import { decode, encode } from "../../shared/remote-codec.js";
import { sessionIdIn } from "../../shared/remote-paths.js";
import { isLoopbackOnlyPath } from "../loopback-only.js";
import type { RosterRow } from "../../shared/types.js";
import { relayThreadText } from "./relay-thread.js";

/** `/users/{uid}/machines/{machineId}/commands/{id}` - a phone's request to
 * this machine's own HTTP server. `/results/{id}` is the daemon's answer to
 * exactly that id. See "Things you do" in the design. */
export interface CommandDoc {
  method: string;
  path: string;
  /** Encoded - see `remote-codec.ts`. Empty string for a body-less request. */
  body: string;
  at: number;
}

export interface ResultDoc {
  status: number;
  contentType: string;
  /** Encoded response text - JSON for an API route, HTML for an artifact. */
  body: string;
}

export function commandsPath(uid: string, machineId: string): string {
  return `users/${uid}/machines/${machineId}/commands`;
}

export function resultPath(uid: string, machineId: string, id: string): string {
  return `users/${uid}/machines/${machineId}/results/${id}`;
}

/** What runs a command once it has been let through: the daemon's own HTTP
 * server, on loopback, with its own token - never the registry directly. See
 * "Routing back through the daemon's own HTTP server" in the design. */
export type LocalCaller = (
  method: string, path: string, body: unknown,
) => Promise<{ status: number; contentType: string; text: string }>;

/**
 * One pass over every pending command: refuse what names a session that is
 * not broadcast, run everything else against the daemon's own server, write
 * the answer, and delete the command - the "2 writes, 2 reads, 2 deletes" per
 * action the design costs, split as: this reads and deletes the command (the
 * phone already paid the write to create it) and writes the result (the
 * phone deletes it once read, see `api.ts`).
 *
 * Returns how many Firestore writes this pass made, so the caller can charge
 * the write budget without this module needing to know about it.
 */
const inFlightCommands = new Set<string>();

/**
 * Commands already answered, by key, with when - owned by the caller (one
 * per bridge) and passed in. A listener's cache can still
 * hold a command for a moment after this daemon deleted it - the delete has
 * to travel to Firestore and back as a change before the cache forgets it -
 * and a tick in that window must not run the same action twice. Kept for a
 * few minutes, far longer than that round trip, then forgotten.
 */
const DONE_TTL_MS = 5 * 60_000;

function forgetOldDone(done: Map<string, number>, now: number): void {
  for (const [key, at] of done) {
    if (now - at > DONE_TTL_MS) done.delete(key);
  }
}

export async function runPendingCommands(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  broadcastRows: RosterRow[],
  callLocal: LocalCaller,
  /** The pending commands, when a listener already has them - skips the
   * `list` read that polling has to pay for. */
  known?: Array<{ id: string; data: Record<string, unknown> }>,
  doneCommands: Map<string, number> = new Map(),
): Promise<number> {
  const broadcast = new Set(broadcastRows.map((r) => r.id));
  const pending = known ?? await client.list(commandsPath(uid, machineId));
  forgetOldDone(doneCommands, Date.now());

  const settled = await Promise.allSettled(pending.map(async ({ id, data }) => {
    const key = `${uid}/${machineId}/${id}`;
    if (inFlightCommands.has(key) || doneCommands.has(key)) return 0;
    inFlightCommands.add(key);
    try {
      const method = String(data.method ?? "GET");
      const path = String(data.path ?? "");
      const bodyText = typeof data.body === "string" ? data.body : "";

      const namedSession = sessionIdIn(path);
      let result: ResultDoc;
      if (isLoopbackOnlyPath(path)) {
        // `callLocal` reaches the server over loopback, so the server's own
        // check would let this through and the key would land in Firestore.
        result = { status: 403, contentType: "application/json", body: encode({ error: "only a program on this machine may borrow a key" }) };
      } else if (namedSession !== null && !broadcast.has(namedSession)) {
        result = { status: 403, contentType: "application/json", body: encode({ error: "this specialist is not broadcast" }) };
      } else {
        result = await run(callLocal, method, path, bodyText);
      }

      await Promise.all([
        client.set(resultPath(uid, machineId, id), result as unknown as Record<string, string | number>),
        client.remove(`${commandsPath(uid, machineId)}/${id}`),
      ]);
      doneCommands.set(key, Date.now());
      return 1;
    } finally {
      inFlightCommands.delete(key);
    }
  }));

  // Settled rather than all-or-nothing: one command whose result could not
  // be written must not hide the writes the others did make from the budget.
  // The first failure is still thrown so the bridge reports Firestore as
  // unreachable, and that command stays in place for the next pass.
  let writes = 0;
  let failure: unknown = null;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") writes += outcome.value;
    else failure ??= outcome.reason;
  }
  if (failure !== null) throw Object.assign(failure as object, { writesBeforeFailure: writes });
  return writes;
}

async function run(callLocal: LocalCaller, method: string, path: string, bodyText: string): Promise<ResultDoc> {
  // Neither failure here is Firestore's, so neither is worth a retry: a body
  // that will not parse never will, and a local call that threw would throw
  // again on the next tick - leaving the command in place to be retried
  // forever while the phone waits out its full timeout. Answer instead.
  let body: unknown;
  try {
    body = bodyText === "" ? undefined : decode(bodyText);
  } catch {
    return { status: 400, contentType: "application/json", body: encode(JSON.stringify({ error: "the command body was not valid" })) };
  }
  let answer: Awaited<ReturnType<LocalCaller>>;
  try {
    answer = await callLocal(method, path, body);
  } catch (error) {
    return {
      status: 502,
      contentType: "application/json",
      body: encode(JSON.stringify({ error: `the daemon could not handle that: ${error instanceof Error ? error.message : String(error)}` })),
    };
  }
  const { status, contentType, text } = answer;
  const relayed = status === 200 && method === "GET" && THREAD_ROUTE.test(path) ? relayThreadText(text) : text;
  const encoded = encode(relayed);
  // Firestore refuses a field this size, and a refused write leaves the
  // command in place to be retried - forever, with the phone waiting on it.
  // An answer that says so is better than one that never comes.
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    return { status: 413, contentType: "application/json", body: encode(JSON.stringify({ error: "too large to send to a remote cockpit; open it on the machine" })) };
  }
  return { status, contentType, body: encoded };
}

const THREAD_ROUTE = /^\/api\/sessions\/[^/]+\/thread$/;

/** Under Firestore's 1,048,487-byte field limit, with room for the rest of
 * the document. */
const MAX_RESULT_BYTES = 1_000_000;
