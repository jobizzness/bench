import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { isDeadToken, payload, recipients, TOO_OLD_MS, type Device, type Request, type Viewer } from "./plan.js";

initializeApp();

/**
 * A daemon asked for a push: a specialist on one of the developer's machines
 * needs them. Send it to every device they switched notifications on for,
 * except one already looking at that tab, then delete the request.
 *
 * europe-west1 because the database is in eur3, and a Firestore trigger has
 * to live in the database's region.
 */
export const sendBenchPush = onDocumentCreated(
  { document: "users/{uid}/machines/{machineId}/notify/{requestId}", region: "europe-west1" },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const { uid, machineId } = event.params;
    const request = snapshot.data() as Request;
    const db = getFirestore();

    try {
      const now = Date.now();
      if (now - Number(request.at ?? 0) > TOO_OLD_MS) return;

      const [deviceDocs, presence] = await Promise.all([
        db.collection(`users/${uid}/devices`).get(),
        db.doc(`users/${uid}/machines/${machineId}/presence/state`).get(),
      ]);
      const devices: Device[] = deviceDocs.docs
        .map((d) => ({ id: d.id, token: String(d.get("token") ?? "") }))
        .filter((d) => d.token !== "");
      const viewers = (presence.get("viewers") ?? {}) as Record<string, Viewer>;
      const to = recipients(devices, viewers, request.sessionId, now);
      if (to.length === 0) return;

      const result = await getMessaging().sendEachForMulticast({
        tokens: to.map((d) => d.token),
        data: payload(request),
        webpush: { headers: { Urgency: "high", TTL: "3600" } },
      });

      // A token FCM no longer recognises is a browser that uninstalled the
      // app or cleared its data. Forget it, or every push pays for it.
      await Promise.all(result.responses.map((r, i) => (
        !r.success && isDeadToken(r.error?.code) ? db.doc(`users/${uid}/devices/${to[i].id}`).delete() : null
      )));
      logger.info("push sent", { uid, sessionId: request.sessionId, sent: result.successCount, failed: result.failureCount });
    } finally {
      await snapshot.ref.delete();
    }
  },
);
