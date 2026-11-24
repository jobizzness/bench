import { getAuth } from "firebase/auth";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { deleteToken, getMessaging, getToken, isSupported } from "firebase/messaging";
import { firebaseApp, firestore } from "./firebase-app.js";
import { deviceId } from "./remote-presence.js";
import { recall, remember } from "./remembered.js";

/**
 * Push notifications on this device: "a specialist needs you", sent by the
 * `sendBenchPush` Cloud Function when a daemon asks for one.
 *
 * The device's FCM token is kept at users/{uid}/devices/{deviceId} - the same
 * device id presence uses, which is how the function knows to skip a device
 * that already has the tab open. The cockpit's own service worker (sw.ts)
 * receives and draws them, so no second worker is registered for FCM.
 */

const KEY = "push";

export type PushState = "on" | "off" | "denied" | "unsupported" | "signed-out";

export async function pushState(): Promise<PushState> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !(await isSupported().catch(() => false))) return "unsupported";
  if (!getAuth(firebaseApp()).currentUser) return "signed-out";
  if (Notification.permission === "denied") return "denied";
  return recall<boolean>(KEY, false) && Notification.permission === "granted" ? "on" : "off";
}

/** Asks for permission - so only ever from a tap - and registers this device. */
export async function enablePush(): Promise<PushState> {
  const uid = getAuth(firebaseApp()).currentUser?.uid;
  if (!uid) return "signed-out";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await saveToken(uid);
  remember(KEY, true);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const uid = getAuth(firebaseApp()).currentUser?.uid;
  remember(KEY, false);
  await deleteToken(getMessaging(firebaseApp())).catch(() => {});
  if (uid) await deleteDoc(doc(firestore(), `users/${uid}/devices/${deviceId()}`)).catch(() => {});
  return "off";
}

/**
 * FCM rotates tokens. A device that switched push on re-saves its current
 * token whenever the cockpit opens, so a rotated one never goes stale on the
 * function's side. Silent, and a no-op for a device that never opted in.
 */
export async function refreshPush(): Promise<void> {
  if ((await pushState()) !== "on") return;
  const uid = getAuth(firebaseApp()).currentUser?.uid;
  if (uid) await saveToken(uid).catch(() => {});
}

async function saveToken(uid: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(firebaseApp()), { serviceWorkerRegistration: registration });
  await setDoc(doc(firestore(), `users/${uid}/devices/${deviceId()}`), {
    token, at: Date.now(), agent: navigator.userAgent.slice(0, 160),
  });
}
