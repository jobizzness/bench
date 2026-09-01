import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getFirestore, initializeFirestore, persistentLocalCache, type Firestore,
} from "firebase/firestore";
import { FIREBASE_WEB_CONFIG } from "../shared/firebase-config.js";

/**
 * One Firebase app for the page, created on first use.
 *
 * Shared by `useRemote.ts` (Auth - `signInWithPopup`), `remote-transport.ts`
 * (Firestore - commands and results) and `useRoster.ts` (Firestore - the
 * merged roster and presence), so all three sit on one identity without
 * importing each other. `initializeApp` is idempotent for the same config -
 * a second call anywhere returns the existing app rather than erroring - so
 * this is a convenience, not a requirement, but three separate copies of the
 * same three lines is not a pattern worth repeating a third time.
 */
let app: FirebaseApp | null = null;

export function firebaseApp(): FirebaseApp {
  app ??= initializeApp(FIREBASE_WEB_CONFIG);
  return app;
}

let db: Firestore | null = null;

/**
 * One Firestore instance for the page, with offline persistence turned on -
 * and it has to be this function, not a bare `getFirestore`, that every
 * caller uses, because whichever one runs first decides the settings for
 * the whole page. `initializeFirestore` can only be called once per app; a
 * second caller reaching for a plain `getFirestore` before this one ran
 * would silently get a Firestore with no persistence; a second caller
 * reaching for `initializeFirestore` again would throw. This is what makes
 * every caller reach for the same instance instead.
 *
 * Firestore bills a reconnected listener as a brand-new query - a full
 * re-read of everything it watches. Persistence is what keeps a phone
 * locking and unlocking all day from paying that every time; see "Offline
 * persistence" in the design.
 */
export function firestore(): Firestore {
  if (db) return db;
  const app = firebaseApp();
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache() });
  } catch {
    // Already initialised elsewhere before this ran (should not happen, since
    // this is the only place that calls `initializeFirestore` - but a browser
    // with no IndexedDB throws here too), or `getFirestore` was already
    // called cold. Either way, the plain instance still works.
    db = getFirestore(app);
  }
  return db;
}
