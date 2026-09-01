import type { FirestoreClient } from "./firestore-rest.js";

/** `/users/{uid}/machines/{machineId}` - one document per laptop, as long as
 * remote is on. See "More than one machine" in the design. */
export interface MachineDoc {
  name: string;
  platform: string;
  version: string;
  lastSeen: number;
}

function machinePath(uid: string, machineId: string): string {
  return `users/${uid}/machines/${machineId}`;
}

/** Written once on connect, and again on every heartbeat and rename - `set`
 * is a Firestore merge-free overwrite of the whole document, which is fine
 * here because the daemon is the only writer of its own machine document. */
export async function registerMachine(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  doc: MachineDoc,
): Promise<void> {
  await client.set(machinePath(uid, machineId), doc as unknown as Record<string, string | number>);
}

/** Advances `lastSeen` so the cockpit can tell an active machine from one
 * that has gone quiet, without touching the name a developer may have typed. */
export async function heartbeat(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  name: string,
  platform: string,
  version: string,
): Promise<void> {
  await registerMachine(client, uid, machineId, { name, platform, version, lastSeen: Date.now() });
}

export async function deregisterMachine(client: FirestoreClient, uid: string, machineId: string): Promise<void> {
  await client.remove(machinePath(uid, machineId));
}
