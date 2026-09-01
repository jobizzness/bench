import { useEffect, useState } from "react";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, type User,
} from "firebase/auth";
import { firebaseApp } from "../firebase-app.js";

export interface FirebaseUser {
  uid: string;
  email: string | null;
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
  }), []);

  const signIn = async () => {
    setError("");
    try {
      await signInWithPopup(getAuth(firebaseApp()), new GoogleAuthProvider());
    } catch {
      // Closing the popup without finishing is the common case, not an error
      // worth naming more precisely than this - same wording as `useRemote.ts`.
      setError("Google sign-in did not complete.");
    }
  };

  return { user: user ? { uid: user.uid, email: user.email } : null, loading, signIn, error };
}
