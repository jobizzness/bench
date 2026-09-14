import { useCallback, useEffect, useRef, useState } from "react";
import { getAuth } from "firebase/auth";
import { authFetch, postJson } from "../api.js";
import { firebaseApp } from "../firebase-app.js";
import { FIREBASE_WEB_CONFIG } from "../../shared/firebase-config.js";
import type { FirebaseUser } from "./useFirebaseUser.js";

interface Credential {
  id: string;
  key: string;
  label: string;
  hint: string;
  status: string;
  checkedAt: number;
  createdAt: number;
}

const documentsUrl = (uid: string, suffix = "") =>
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_WEB_CONFIG.projectId}/databases/(default)/documents/users/${uid}/anthropicCredentials${suffix}`;

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
  };
}

async function listCredentials(uid: string): Promise<Credential[]> {
  const res = await fetch(documentsUrl(uid), { headers: await headers() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error("could not read credentials");
  const body = await res.json() as { documents?: Array<{ name: string; fields?: Record<string, { stringValue?: string; integerValue?: string }> }> };
  return (body.documents ?? []).map((item) => ({
    id: item.name.slice(item.name.lastIndexOf("/") + 1),
    key: item.fields?.key?.stringValue ?? "",
    label: item.fields?.label?.stringValue ?? "Anthropic key",
    hint: item.fields?.hint?.stringValue ?? "…",
    status: item.fields?.status?.stringValue ?? "unchecked",
    checkedAt: Number(item.fields?.checkedAt?.integerValue ?? 0),
    createdAt: Number(item.fields?.createdAt?.integerValue ?? 0),
  })).filter((item) => item.key !== "");
}

async function putCredential(uid: string, credential: Credential): Promise<void> {
  const res = await fetch(documentsUrl(uid, `/${credential.id}`), {
    method: "PATCH",
    headers: await headers(),
    body: JSON.stringify({ fields: fieldsOf(credential) }),
  });
  if (!res.ok) throw new Error("could not save credential");
}

async function removeCredential(uid: string, id: string): Promise<void> {
  const res = await fetch(documentsUrl(uid, `/${id}`), { method: "DELETE", headers: await headers() });
  if (!res.ok && res.status !== 404) throw new Error("could not remove credential");
}

export function ProfileDialog({ open, user, onClose, onSignIn }: {
  open: boolean;
  user: FirebaseUser | null;
  onClose: () => void;
  onSignIn: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close(); return; }
    dialog.showModal();
  }, [open]);

  const sync = useCallback(async () => {
    if (!user) { setCredentials([]); return; }
    const stored = await listCredentials(user.uid);
    const res = await postJson("/api/anthropic-keys", { credentials: stored.map(({ id, key: value, label: name, status, checkedAt }) => ({ id, key: value, label: name, status, checkedAt })) });
    if (!res.ok) throw new Error("active Bench could not load credentials");
    const body = await res.json() as { credentials?: Array<{ id: string; status: string; checkedAt: number }> };
    const states = new Map((body.credentials ?? []).map((item) => [item.id, item]));
    const next = stored.map((credential) => {
      const state = states.get(credential.id);
      return state ? { ...credential, status: state.status, checkedAt: state.checkedAt } : credential;
    });
    await Promise.all(next.filter((credential, index) => credential.status !== stored[index].status || credential.checkedAt !== stored[index].checkedAt).map((credential) => putCredential(user.uid, credential)));
    setCredentials(next);
  }, [user]);

  useEffect(() => {
    setError("");
    void sync().catch(() => setError("Credentials are saved, but the active Bench could not load them."));
    if (!user) return;
    const timer = setInterval(async () => {
      try {
        const res = await authFetch("/api/anthropic-keys");
        if (!res.ok) return;
        const body = await res.json() as { credentials?: Array<{ id: string; status: string; checkedAt: number }> };
        const reported = body.credentials ?? [];
        const states = new Map(reported.map((item) => [item.id, item]));
        setCredentials((current) => current.map((credential) => {
          const state = states.get(credential.id);
          if (!state) return credential;
          const next = { ...credential, status: state.status, checkedAt: state.checkedAt };
          if (next.status !== credential.status || next.checkedAt !== credential.checkedAt) void putCredential(user.uid, next);
          return next;
        }));
        if (reported.some((item) => item.status === "exhausted" && Date.now() - item.checkedAt >= 15 * 60_000)) await sync();
      } catch {
        return;
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [sync, user]);

  const save = async () => {
    if (!user || key.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const value = key.trim();
      await putCredential(user.uid, {
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
    if (!user) return;
    try {
      await removeCredential(user.uid, id);
      await sync();
    } catch {
      setError("Could not remove that credential.");
    }
  };

  return (
    <dialog ref={ref} id="profile-dialog" className="sheet" onClose={onClose}>
      <div className="profile-body">
        <header><div><h2>Profile</h2>{user?.email && <p>{user.email}</p>}</div><button type="button" onClick={onClose}>Close</button></header>
        {!user ? (
          <section className="profile-sign-in"><p>Sign in to manage your credentials across Bench.</p><button type="button" disabled={busy} onClick={() => void onSignIn()}>Continue with Google</button></section>
        ) : (
          <>
            <section><h3>Anthropic credentials</h3><ul className="credential-list">{credentials.map((credential) => (
              <li key={credential.id}><div><strong>{credential.label}</strong><span>{credential.hint}</span></div><div><span className={`credential-status ${credential.status}`}>{credential.status}</span><button type="button" onClick={() => void remove(credential.id)}>Remove</button></div></li>
            ))}</ul>{credentials.length === 0 && <p className="field-note">No credentials saved.</p>}</section>
            <section className="credential-add"><h3>Add a key</h3><input aria-label="Key name" placeholder="Name (optional)" value={label} onChange={(event) => setLabel(event.target.value)} /><input aria-label="Anthropic API key" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(event) => setKey(event.target.value)} /><button type="button" disabled={busy || key.trim() === ""} onClick={() => void save()}>Save key</button></section>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </dialog>
  );
}
