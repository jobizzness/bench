import { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "firebase/auth";
import { authFetch, postJson } from "../api.js";
import { firebaseApp } from "../firebase-app.js";
import { FIREBASE_WEB_CONFIG } from "../../shared/firebase-config.js";
import { fullest, type UsageWindow } from "../../shared/usage.js";
import { UsageBars } from "./UsageBars.js";
import type { FirebaseUser } from "./useFirebaseUser.js";

interface Credential {
  id: string;
  key: string;
  label: string;
  hint: string;
  status: string;
  checkedAt: number;
  createdAt: number;
  /** Which key the daemon is spending, and what it has left. From the
   * daemon, not Firestore - kept out of `fieldsOf` so neither is written
   * down. */
  active?: boolean;
  usage?: UsageWindow[];
  resetsAt?: string | null;
}

const documentsUrl = (uid: string, collection: string, suffix = "") =>
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_WEB_CONFIG.projectId}/databases/(default)/documents/users/${uid}/${collection}${suffix}`;

async function headers(): Promise<Record<string, string>> {
  const token = await getAuth(firebaseApp()).currentUser?.getIdToken();
  if (!token) throw new Error("not signed in");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function fieldsOf(credential: Credential) {
  return {
    key: { stringValue: credential.key },
    label: { stringValue: credential.label },
    hint: { stringValue: credential.hint },
    status: { stringValue: credential.status },
    checkedAt: { integerValue: String(credential.checkedAt) },
    createdAt: { integerValue: String(credential.createdAt) },
    // Present only when the daemon said when the limit lifts: a PATCH without
    // an updateMask rewrites the document, so leaving it out clears it.
    ...(typeof credential.resetsAt === "string" && credential.resetsAt !== ""
      ? { resetsAt: { stringValue: credential.resetsAt } }
      : {}),
  };
}

async function listCredentials(uid: string, collection: string, fallbackLabel: string): Promise<Credential[]> {
  const res = await fetch(documentsUrl(uid, collection), { headers: await headers() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error("could not read credentials");
  const body = await res.json() as { documents?: Array<{ name: string; fields?: Record<string, { stringValue?: string; integerValue?: string }> }> };
  return (body.documents ?? []).map((item) => ({
    id: item.name.slice(item.name.lastIndexOf("/") + 1),
    key: item.fields?.key?.stringValue ?? "",
    label: item.fields?.label?.stringValue ?? fallbackLabel,
    hint: item.fields?.hint?.stringValue ?? "…",
    status: item.fields?.status?.stringValue ?? "unchecked",
    checkedAt: Number(item.fields?.checkedAt?.integerValue ?? 0),
    createdAt: Number(item.fields?.createdAt?.integerValue ?? 0),
    resetsAt: item.fields?.resetsAt?.stringValue ?? null,
  })).filter((item) => item.key !== "");
}

async function putCredential(uid: string, collection: string, credential: Credential): Promise<void> {
  const res = await fetch(documentsUrl(uid, collection, `/${credential.id}`), {
    method: "PATCH",
    headers: await headers(),
    body: JSON.stringify({ fields: fieldsOf(credential) }),
  });
  if (!res.ok) throw new Error("could not save credential");
}

async function removeCredential(uid: string, collection: string, id: string): Promise<void> {
  const res = await fetch(documentsUrl(uid, collection, `/${id}`), { method: "DELETE", headers: await headers() });
  if (!res.ok && res.status !== 404) throw new Error("could not remove credential");
}

/** "checked 2m ago" - the check that produced a status, said in words. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "resets in 1h 5m" - when a spent key comes back, said in words. */
function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

interface DaemonState {
  id: string;
  status: string;
  checkedAt: number;
  active: boolean;
  usage?: UsageWindow[];
  resetsAt?: string | null;
}

function CredentialSection({ user, title, collection, endpoint, placeholder, noneNote, addLabel, fallbackLabel, billedNote }: {
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
}) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const sync = useCallback(async () => {
    const stored = await listCredentials(user.uid, collection, fallbackLabel);
    const res = await postJson(endpoint, { credentials: stored.map(({ id, key: value, label: name, status, checkedAt, resetsAt }) => ({ id, key: value, label: name, status, checkedAt, resetsAt })) });
    if (!res.ok) throw new Error("active Bench could not load credentials");
    const body = await res.json() as { credentials?: DaemonState[] };
    const states = new Map((body.credentials ?? []).map((item) => [item.id, item]));
    const next = stored.map((credential) => {
      const state = states.get(credential.id);
      return state
        ? { ...credential, status: state.status, checkedAt: state.checkedAt, active: state.active, usage: state.usage, resetsAt: state.resetsAt }
        : credential;
    });
    await Promise.all(next.filter((credential, index) => credential.status !== stored[index].status || credential.checkedAt !== stored[index].checkedAt || credential.resetsAt !== stored[index].resetsAt).map((credential) => putCredential(user.uid, collection, credential)));
    setCredentials(next);
  }, [user, collection, endpoint, fallbackLabel]);

  useEffect(() => {
    setError("");
    void sync().catch(() => setError("Credentials are saved, but the active Bench could not load them."));
    const timer = setInterval(async () => {
      try {
        const res = await authFetch(endpoint);
        if (!res.ok) return;
        const body = await res.json() as { credentials?: DaemonState[] };
        const reported = body.credentials ?? [];
        const states = new Map(reported.map((item) => [item.id, item]));
        setCredentials((current) => current.map((credential) => {
          const state = states.get(credential.id);
          if (!state) return credential;
          const next = { ...credential, status: state.status, checkedAt: state.checkedAt, active: state.active, usage: state.usage, resetsAt: state.resetsAt };
          if (next.status !== credential.status || next.checkedAt !== credential.checkedAt || next.resetsAt !== credential.resetsAt) void putCredential(user.uid, collection, next);
          return next;
        }));
        // A spent key is asked about again when its window has turned over -
        // or, when the API never said when that is, after the same fifteen
        // minutes the daemon cools it down for.
        if (reported.some((item) => item.status === "exhausted" && (item.resetsAt ? Date.parse(item.resetsAt) <= Date.now() : Date.now() - item.checkedAt >= 15 * 60_000))) await sync();
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

  const active = credentials.find((credential) => credential.active);
  const activeFull = active?.usage ? fullest(active.usage) : null;

  return (
    <>
      <section><h3>{title}</h3><ul className="credential-list">{credentials.map((credential) => {
        const full = credential.usage && credential.usage.length > 0 ? fullest(credential.usage) : null;
        return (
        <li key={credential.id}>
          <div className="credential-head"><div><strong>{credential.label}</strong><span>{credential.hint}</span>{full && <span>{full.label} {full.percent}%</span>}{credential.status === "exhausted" && credential.resetsAt && <span>resets in {until(credential.resetsAt)}</span>}{!credential.usage?.length && billedNote && !credential.key.startsWith("sk-ant-oat") && <span>{billedNote}</span>}</div><div>{credential.active && <span className="credential-active">In use</span>}<span className={`credential-status ${credential.status}`}>{credential.status}</span>{credential.checkedAt > 0 && <span>checked {ago(credential.checkedAt)}</span>}<button type="button" onClick={() => void remove(credential.id)}>Remove</button></div></div>
          {credential.usage && credential.usage.length > 0 && <div className="credential-usage"><UsageBars windows={credential.usage} /></div>}
        </li>
        );
      })}</ul>{credentials.length === 0 && <p className="field-note">No credentials saved.</p>}
        <p className="field-note credential-summary">{active ? `Specialists are running on ${active.label} (${active.hint})${activeFull ? ` — ${activeFull.label} ${activeFull.percent}% used` : ""}.` : noneNote}</p>
      </section>
      <section className="credential-add"><h3>{addLabel}</h3><input aria-label="Key name" placeholder="Name (optional)" value={label} onChange={(event) => setLabel(event.target.value)} /><input aria-label={`${title} key`} type="password" autoComplete="off" placeholder={placeholder} value={key} onChange={(event) => setKey(event.target.value)} /><button type="button" disabled={busy || key.trim() === ""} onClick={() => void save()}>Save key</button></section>
      {error && <p className="error">{error}</p>}
    </>
  );
}

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
      <div className="profile-body">
        <header><div><h2>Profile</h2>{user?.email && <p>{user.email}</p>}</div><button type="button" onClick={onClose}>Close</button></header>
        {!user ? (
          <section className="profile-sign-in"><p>Sign in to manage your credentials across Bench. This Bench keeps them synced while it runs, cockpit open or not.</p><button type="button" disabled={busy} onClick={() => { setBusy(true); void onSignIn().finally(() => setBusy(false)); }}>Continue with Google</button></section>
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
      </div>
    </dialog>
  );
}
