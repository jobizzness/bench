import { useCallback, useEffect, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { fullest } from "../../shared/usage.js";
import {
  listCredentials, putCredential, removeCredential, type Credential, type DaemonState,
} from "../credential-store.js";
import { CredentialRow } from "./CredentialRow.js";
import type { FirebaseUser } from "./useFirebaseUser.js";

/** A spent key is asked about again once its window has turned over - or,
 * when the API never said when that is, after the same fifteen minutes the
 * daemon cools it down for. */
function dueForRecheck(item: DaemonState): boolean {
  if (item.status !== "exhausted") return false;
  return item.resetsAt ? Date.parse(item.resetsAt) <= Date.now() : Date.now() - item.checkedAt >= 15 * 60_000;
}

function mergeState(credential: Credential, state: DaemonState): Credential {
  return {
    ...credential,
    status: state.status, checkedAt: state.checkedAt, active: state.active,
    pinned: state.pinned, usage: state.usage, resetsAt: state.resetsAt,
  };
}

function changed(next: Credential, prior: Credential): boolean {
  return next.status !== prior.status || next.checkedAt !== prior.checkedAt || next.resetsAt !== prior.resetsAt;
}

/**
 * One list of credentials - Anthropic or OpenRouter - synced to Firestore and
 * to the daemon that spends them.
 *
 * Every call here passes `local: true` (#139): this section is reached from
 * the Profile dialog, which has no session of its own to route by, so
 * without it these would follow `activeMachine` - whichever specialist's tab
 * happens to be open - and a pin could land on a daemon other than the one
 * that served this page.
 */
export function CredentialSection({
  user, title, collection, endpoint, placeholder, noneNote, addLabel, fallbackLabel, billedNote, pinnable,
}: {
  user: FirebaseUser;
  title: string;
  /** The Firestore subcollection under the user's document. */
  collection: "anthropicCredentials" | "openRouterCredentials";
  /** The daemon route this list is synced to and polled from. */
  endpoint: "/api/anthropic-keys" | "/api/openrouter/keys";
  placeholder: string;
  /** What a specialist runs on when no key in this list is usable. */
  noneNote: string;
  addLabel: string;
  fallbackLabel: string;
  /** What to say beside a key that has no windows to report - a console key
   * is billed, not rationed. */
  billedNote?: string;
  /** Only the Anthropic list can be pinned - see #135. */
  pinnable?: boolean;
}) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pinning, setPinning] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const stored = await listCredentials(user.uid, collection, fallbackLabel);
    const res = await postJson(endpoint, {
      credentials: stored.map(({ id, key: value, label: name, status, checkedAt, resetsAt }) =>
        ({ id, key: value, label: name, status, checkedAt, resetsAt })),
    }, { local: true });
    if (!res.ok) throw new Error("active Bench could not load credentials");
    const body = await res.json() as { credentials?: DaemonState[] };
    const states = new Map((body.credentials ?? []).map((item) => [item.id, item]));
    const next = stored.map((credential) => {
      const state = states.get(credential.id);
      return state ? mergeState(credential, state) : credential;
    });
    await Promise.all(
      next.filter((credential, index) => changed(credential, stored[index]!))
        .map((credential) => putCredential(user.uid, collection, credential)),
    );
    setCredentials(next);
  }, [user, collection, endpoint, fallbackLabel]);

  useEffect(() => {
    setError("");
    void sync().catch(() => setError("Credentials are saved, but the active Bench could not load them."));

    const timer = setInterval(async () => {
      try {
        const res = await authFetch(endpoint, undefined, { local: true });
        if (!res.ok) return;
        const body = await res.json() as { credentials?: DaemonState[] };
        const reported = body.credentials ?? [];
        const states = new Map(reported.map((item) => [item.id, item]));
        setCredentials((current) => current.map((credential) => {
          const state = states.get(credential.id);
          if (!state) return credential;
          const next = mergeState(credential, state);
          if (changed(next, credential)) void putCredential(user.uid, collection, next);
          return next;
        }));
        if (reported.some(dueForRecheck)) await sync();
      } catch {
        return;
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [sync, user, endpoint, collection]);

  const save = async () => {
    if (key.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const value = key.trim();
      await putCredential(user.uid, collection, {
        id: crypto.randomUUID(), key: value,
        label: label.trim() || `Key ${value.slice(-4)}`,
        hint: value.length > 8 ? `…${value.slice(-4)}` : "…",
        status: "unchecked", checkedAt: 0, createdAt: Date.now(),
      });
      setKey("");
      setLabel("");
      await sync();
    } catch {
      setError("Could not save that credential.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await removeCredential(user.uid, collection, id);
      await sync();
    } catch {
      setError("Could not remove that credential.");
    }
  };

  const togglePin = async (credential: Credential) => {
    setPinning(credential.id);
    setError("");
    try {
      const res = await postJson(
        "/api/anthropic-keys/pin", { id: credential.pinned ? null : credential.id }, { local: true },
      );
      if (!res.ok) throw new Error("could not set pin");
      const body = await res.json() as { credentials?: DaemonState[] };
      const states = new Map((body.credentials ?? []).map((item) => [item.id, item]));
      setCredentials((current) => current.map((item) => {
        const state = states.get(item.id);
        return state ? mergeState(item, state) : item;
      }));
    } catch {
      setError("Could not change the pin.");
    } finally {
      setPinning(null);
    }
  };

  const active = credentials.find((credential) => credential.active);
  const activeFull = active?.usage ? fullest(active.usage) : null;

  return (
    <>
      <section className="model-house" data-house={collection}>
        <h3>{title}</h3>
        <ul className="credential-list">
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              billedNote={billedNote}
              onRemove={(id) => void remove(id)}
              pin={pinnable
                ? { pinned: credential.pinned === true, busy: pinning === credential.id, onToggle: () => void togglePin(credential) }
                : undefined}
            />
          ))}
        </ul>
        {credentials.length === 0 && <p className="field-note">No credentials saved.</p>}
        <p className="field-note credential-summary">
          {active
            ? `Specialists are running on ${active.label} (${active.hint})` +
              (activeFull ? ` — ${activeFull.label} ${activeFull.percent}% used` : "") + "."
            : noneNote}
        </p>
      </section>

      <section className="model-house credential-add" data-house={`${collection}-add`}>
        <h3>{addLabel}</h3>
        <input aria-label="Key name" placeholder="Name (optional)" value={label}
          onChange={(event) => setLabel(event.target.value)} />
        <input aria-label={`${title} key`} type="password" autoComplete="off" placeholder={placeholder}
          value={key} onChange={(event) => setKey(event.target.value)} />
        <button type="button" disabled={busy || key.trim() === ""} onClick={() => void save()}>
          Save key
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    </>
  );
}
