import type { FirestoreClient } from "./firestore-rest.js";
import { decode, encode } from "../../shared/remote-codec.js";
import { sessionIdIn } from "../../shared/remote-paths.js";
import type { RosterRow } from "../../shared/types.js";

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
export async function runPendingCommands(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  broadcastRows: RosterRow[],
  callLocal: LocalCaller,
): Promise<number> {
  const broadcast = new Set(broadcastRows.map((r) => r.id));
  const pending = await client.list(commandsPath(uid, machineId));
  let writes = 0;

  for (const { id, data } of pending) {
    const method = String(data.method ?? "GET");
    const path = String(data.path ?? "");
    const bodyText = typeof data.body === "string" ? data.body : "";

    const namedSession = sessionIdIn(path);
    const result: ResultDoc = namedSession !== null && !broadcast.has(namedSession)
      ? { status: 403, contentType: "application/json", body: encode({ error: "this specialist is not broadcast" }) }
      : await run(callLocal, method, path, bodyText);

    await client.set(resultPath(uid, machineId, id), result as unknown as Record<string, string | number>);
    writes += 1;
    await client.remove(`${commandsPath(uid, machineId)}/${id}`);
  }

  return writes;
}

async function run(callLocal: LocalCaller, method: string, path: string, bodyText: string): Promise<ResultDoc> {
  const body = bodyText === "" ? undefined : decode(bodyText);
  const { status, contentType, text } = await callLocal(method, path, body);
  return { status, contentType, body: encode(text) };
}
