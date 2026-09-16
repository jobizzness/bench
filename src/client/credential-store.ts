import { getAuth } from "firebase/auth";
import { firebaseApp } from "./firebase-app.js";
import { FIREBASE_WEB_CONFIG } from "../shared/firebase-config.js";
import type { UsageWindow } from "../shared/usage.js";

/**
 * A credential as Firestore holds it, plus what the daemon says about it once
 * synced: which one it is spending, and what that key has left. The daemon's
 * half is not written down - it is asked for fresh every time.
 */
export interface Credential {
  id: string;
  key: string;
  label: string;
  hint: string;
  status: string;
  checkedAt: number;
  createdAt: number;
  active?: boolean;
  /** Whether this is the one credential the developer has told this bench to
   * spend. Anthropic only - see `pinnedManagedKeyId` in settings.ts. */
  pinned?: boolean;
  usage?: UsageWindow[];
  resetsAt?: string | null;
}

/** What the daemon reports back for a credential it holds - everything about
 * it except the key itself, which never leaves the daemon. */
export interface DaemonState {
  id: string;
  status: string;
  checkedAt: number;
  active: boolean;
  pinned?: boolean;
  usage?: UsageWindow[];
  resetsAt?: string | null;
}

const documentsUrl = (uid: string, collection: string, suffix = "") =>
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_WEB_CONFIG.projectId}` +
  `/databases/(default)/documents/users/${uid}/${collection}${suffix}`;

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

export async function listCredentials(
  uid: string, collection: string, fallbackLabel: string,
): Promise<Credential[]> {
  const res = await fetch(documentsUrl(uid, collection), { headers: await headers() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error("could not read credentials");
  const body = await res.json() as {
    documents?: Array<{ name: string; fields?: Record<string, { stringValue?: string; integerValue?: string }> }>;
  };
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

export async function putCredential(uid: string, collection: string, credential: Credential): Promise<void> {
  const res = await fetch(documentsUrl(uid, collection, `/${credential.id}`), {
    method: "PATCH",
    headers: await headers(),
    body: JSON.stringify({ fields: fieldsOf(credential) }),
  });
  if (!res.ok) throw new Error("could not save credential");
}

export async function removeCredential(uid: string, collection: string, id: string): Promise<void> {
  const res = await fetch(documentsUrl(uid, collection, `/${id}`), { method: "DELETE", headers: await headers() });
  if (!res.ok && res.status !== 404) throw new Error("could not remove credential");
}
