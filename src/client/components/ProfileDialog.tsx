import { useEffect, useRef, useState } from "react";
import { CredentialSection } from "./CredentialSection.js";
import type { FirebaseUser } from "./useFirebaseUser.js";

/**
 * Where the developer's credentials live - synced to Firestore, and to
 * whichever daemon is running, for as long as it does.
 *
 * Styled like the rest of the app rather than as a dialog of its own: see
 * `ModelDialog.tsx` for the `model-house` / `field-note` vocabulary this
 * reuses.
 */
export function ProfileDialog({ open, user, onClose, onSignIn }: {
  open: boolean;
  user: FirebaseUser | null;
  onClose: () => void;
  onSignIn: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close(); return; }
    dialog.showModal();
  }, [open]);

  return (
    <dialog ref={ref} id="profile-dialog" className="sheet" onClose={onClose}>
      <h2>Profile</h2>
      <p className="field-note" id="profile-dialog-note">
        {user?.email ?? "Sign in to manage your credentials across Bench."}
      </p>

      {!user ? (
        <section className="model-house" data-house="sign-in">
          <p className="field-note">
            This Bench keeps your keys synced while it runs, cockpit open or not.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setBusy(true); void onSignIn().finally(() => setBusy(false)); }}
          >
            Continue with Google
          </button>
        </section>
      ) : (
        <>
          <CredentialSection
            user={user}
            title="Anthropic credentials"
            collection="anthropicCredentials"
            endpoint="/api/anthropic-keys"
            placeholder="sk-ant-…"
            noneNote="No usable key — specialists use this machine's Claude login."
            addLabel="Add an Anthropic key"
            fallbackLabel="Anthropic key"
            billedNote="pay-as-you-go"
            pinnable
          />
          <CredentialSection
            user={user}
            title="OpenRouter credentials"
            collection="openRouterCredentials"
            endpoint="/api/openrouter/keys"
            placeholder="sk-or-v1-…"
            noneNote="No usable key — only Anthropic's models are offered."
            addLabel="Add an OpenRouter key"
            fallbackLabel="OpenRouter key"
          />
        </>
      )}

      <div className="actions">
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
