import { useEffect, useState } from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { authFetch, postJson } from "../api.js";
import { FIREBASE_WEB_CONFIG } from "../../shared/firebase-config.js";
import { REMOTE_OFF, type RemoteState } from "../../shared/remote.js";

/** One Firebase app for the page, created on first use rather than at module
 * load - most cockpit sessions never open Settings, and initializeApp talks
 * to nothing but is still work a page that never touches remote should not
 * pay for. */
let app: FirebaseApp | null = null;
function firebaseApp(): FirebaseApp {
  app ??= initializeApp(FIREBASE_WEB_CONFIG);
  return app;
}

/**
 * The daemon's Google identity, and the two actions Settings offers on it.
 *
 * Everything that talks to Google lives here rather than in `Remote.tsx`:
 * `signInWithPopup` is the one call in the whole cockpit that is not
 * `authFetch`, and keeping it out of the component is what lets the
 * component stay about rendering.
 */
export function useRemote(open: boolean) {
  const [state, setState] = useState<RemoteState>(REMOTE_OFF);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    let live = true;
    void (async () => {
      const res = await authFetch("/api/remote");
      if (!live || !res.ok) return;
      setState(await res.json());
    })();
    return () => { live = false; };
  }, [open]);

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      const credential = await signInWithPopup(getAuth(firebaseApp()), new GoogleAuthProvider());
      const user = credential.user;
      const res = await postJson("/api/remote/identity", {
        refreshToken: user.refreshToken,
        uid: user.uid,
        email: user.email,
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "Could not turn remote on."); return; }
      setState(body);
    } catch {
      // Closing the Google popup without finishing is the common case, not
      // an error worth naming more precisely than this.
      setError("Google sign-in did not complete.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await authFetch("/api/remote", { method: "DELETE" });
      if (!res.ok) { setError("Could not turn remote off."); return; }
      setState(await res.json());
    } finally {
      setBusy(false);
    }
  };

  const rename = async (name: string) => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/remote/machine", { name });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "Could not rename this machine."); return; }
      setState(body);
    } finally {
      setBusy(false);
    }
  };

  return { state, busy, error, connect, disconnect, rename };
}
