import { useEffect, useState } from "react";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, type User,
} from "firebase/auth";
import { authFetch, postJson } from "../api.js";
import { firebaseApp } from "../firebase-app.js";
import type { RemoteState } from "../../shared/remote.js";

export interface FirebaseUser {
  uid: string;
  email: string | null;
}

/**
 * Hand this daemon the same Google identity "Turn on remote" would - it is
 * what lets the daemon keep the profile's keys synced while no cockpit is
 * open. Best-effort: a hosted or phone cockpit has no daemon to answer, and
 * signing in still worked.
 */
async function handIdentityToDaemon(user: User): Promise<void> {
  try {
    await postJson("/api/remote/identity", {
      refreshToken: user.refreshToken,
      uid: user.uid,
      email: user.email,
    });
  } catch {
    return;
  }
}

/** A signed-in browser on a daemon that does not hold the identity yet -
 * a daemon restarted since the sign-in, or one the sign-in predates. */
async function handIdentityIfDaemonLacksIt(user: User): Promise<void> {
  try {
    const res = await authFetch("/api/remote");
    if (!res.ok) return;
    const state = await res.json() as RemoteState;
    if (!state.connected) await handIdentityToDaemon(user);
  } catch {
    return;
  }
}

/**
 * Whether anyone is signed into Firebase in this browser - daemon-free,
 * unlike `useRemote.ts`, which signs in *and* hands the credential to a
 * local daemon. A phone only ever needs this half: sign in once, and the
 * merged roster and every command from then on ride on the same identity,
 * with no daemon address involved at all. See "The phone's first screen is
 * sign-in, not 'Where is Bench running?'" in the design.
 *
 * `loading` is true only until the SDK has read back whatever session it
 * already had - the difference between "definitely signed out" and "still
 * finding out", which matters here because the wrong guess shows the wrong
 * first screen for a moment.
 */
export function useFirebaseUser(): {
  user: FirebaseUser | null;
  loading: boolean;
  signIn: () => Promise<void>;
  error: string;
} {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => onAuthStateChanged(getAuth(firebaseApp()), (next) => {
    setUser(next);
    setLoading(false);
    if (next) void handIdentityIfDaemonLacksIt(next);
  }), []);

  const signIn = async () => {
    setError("");
    try {
      const credential = await signInWithPopup(getAuth(firebaseApp()), new GoogleAuthProvider());
      await handIdentityToDaemon(credential.user);
    } catch {
      // Closing the popup without finishing is the common case, not an error
      // worth naming more precisely than this - same wording as `useRemote.ts`.
      setError("Google sign-in did not complete.");
    }
  };

  return { user: user ? { uid: user.uid, email: user.email } : null, loading, signIn, error };
}
