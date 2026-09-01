import { deleteDoc, doc, onSnapshot, setDoc } from "firebase/firestore";
import { firestore } from "./firebase-app.js";
import { encode, decode } from "../shared/remote-codec.js";

/**
 * The relayed half of the transport: a command written, a result listened
 * for, both against a *machine other than the one that served this page*.
 * The direct half - `fetch`/`WebSocket` in `api.ts` - never touches this
 * file, and this file never touches a session's HTTP verbs; it only carries
 * whatever `api.ts` hands it there and back. See "The seam" in the design.
 */

export interface RemoteResult {
  status: number;
  contentType: string;
  text: string;
}

/**
 * One request-and-reply over Firestore: write `commands/{id}`, listen for
 * `results/{id}`, delete the result once read - the phone's half of "both
 * documents are then deleted" (the daemon deletes the command; see
 * `command-runner.ts`).
 */
export function sendCommand(
  uid: string, machineId: string, method: string, path: string, body: unknown,
): Promise<RemoteResult> {
  const database = firestore();
  const id = crypto.randomUUID();
  const commandRef = doc(database, `users/${uid}/machines/${machineId}/commands/${id}`);
  const resultRef = doc(database, `users/${uid}/machines/${machineId}/results/${id}`);

  return new Promise<RemoteResult>((resolve, reject) => {
    const unsubscribe = onSnapshot(resultRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data() as { status: number; contentType: string; body: string };
      unsubscribe();
      void deleteDoc(resultRef).catch(() => {
        // Nothing the caller needs to know - an orphaned result is cleaned
        // up defensively by `bench remote off`, and by the next `wipe()`.
      });
      resolve({ status: Number(data.status), contentType: String(data.contentType), text: decode(data.body) });
    }, (error) => { unsubscribe(); reject(error); });

    void setDoc(commandRef, {
      method,
      path,
      body: body === undefined ? "" : encode(body),
      at: Date.now(),
    }).catch((error: unknown) => { unsubscribe(); reject(error); });
  });
}
