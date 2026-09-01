/**
 * The Firestore REST API, called directly with an ID token as bearer auth.
 *
 * Not the Admin SDK - that authenticates as a service account, which is
 * billing-account territory. An ID token from `token-refresh.ts` authenticates
 * as the developer's own Google account instead, and the security rules in
 * `firestore.rules` are what admit exactly that uid. This module only needs
 * to encode a plain object into Firestore's typed field format and back, and
 * call three verbs - small enough that reaching for a client library here
 * would be more surface than the daemon needs.
 */

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { timestampValue: string };

type FirestoreFields = Record<string, FirestoreValue>;

/** A plain object, one level deep, of strings and numbers - everything this
 * ticket writes to Firestore (a machine's name, platform, version, lastSeen)
 * fits that, and a converter that only has to handle it stays small. */
export type DocData = Record<string, string | number>;

function toFields(data: DocData): FirestoreFields {
  const fields: FirestoreFields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = typeof value === "number"
      ? { integerValue: String(Math.trunc(value)) }
      : { stringValue: value };
  }
  return fields;
}

function fromFields(fields: FirestoreFields | undefined): DocData {
  const data: DocData = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if ("integerValue" in value) data[key] = Number(value.integerValue);
    else if ("stringValue" in value) data[key] = value.stringValue;
    else if ("timestampValue" in value) data[key] = Date.parse(value.timestampValue);
  }
  return data;
}

function documentUrl(projectId: string, path: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
}

export interface FirestoreClientOptions {
  projectId: string;
  /** The current ID token. A function, not a value, so every call reads
   * whatever `Refresher` currently holds rather than one handed over once
   * and left to go stale. */
  idToken: () => string | null;
  fetchImpl?: typeof fetch;
}

/** Thrown for anything the caller should treat as "that write did not
 * happen" - including no ID token being available yet. */
export class FirestoreRequestFailed extends Error {}

function authHeader(idToken: string | null): Record<string, string> {
  if (idToken === null) throw new FirestoreRequestFailed("no ID token to call Firestore with");
  return { authorization: `Bearer ${idToken}` };
}

/**
 * A minimal client for one document path at a time.
 *
 * `set` and `delete` are the only two verbs this ticket needs: a machine
 * registers itself, updates `lastSeen` and its name in place, and is deleted
 * when remote turns off. Nothing here lists or queries a collection - see
 * "There are no unbounded collections" in the design.
 */
export function firestoreClient(opts: FirestoreClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function set(path: string, data: DocData): Promise<void> {
    const res = await fetchImpl(documentUrl(opts.projectId, path), {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeader(opts.idToken()) },
      body: JSON.stringify({ fields: toFields(data) }),
    });
    if (!res.ok) throw new FirestoreRequestFailed(`could not write ${path}: ${res.status} ${await res.text()}`);
  }

  async function get(path: string): Promise<DocData | null> {
    const res = await fetchImpl(documentUrl(opts.projectId, path), {
      headers: authHeader(opts.idToken()),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new FirestoreRequestFailed(`could not read ${path}: ${res.status} ${await res.text()}`);
    return fromFields((await res.json()).fields);
  }

  async function remove(path: string): Promise<void> {
    const res = await fetchImpl(documentUrl(opts.projectId, path), {
      method: "DELETE",
      headers: authHeader(opts.idToken()),
    });
    // A document already gone is the state a delete was asked for - not a
    // failure to report back.
    if (!res.ok && res.status !== 404) {
      throw new FirestoreRequestFailed(`could not delete ${path}: ${res.status} ${await res.text()}`);
    }
  }

  return { set, get, remove };
}

export type FirestoreClient = ReturnType<typeof firestoreClient>;
