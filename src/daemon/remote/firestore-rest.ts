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
 * A minimal client for one document - or one collection's worth of documents
 * - at a time.
 *
 * `set` and `remove` are what a machine document needs: register, update
 * `lastSeen` and the name in place, delete on disconnect. `list` is what the
 * bridge in `bridge.ts` needs on top: reading every `commands` or `viewers`
 * document, since there is no push listener available without the Admin SDK
 * (see that file's own comment for why). Still never a query beyond "every
 * document in this one collection" - see "There are no unbounded
 * collections" in the design, which both collections satisfy by construction.
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

  /**
   * Every document directly under a collection - `commands` and `viewers`,
   * the two the daemon has no way to watch (see `bridge.ts` for why it polls
   * instead of listening) and so has to ask for outright.
   *
   * Still no query, still one collection at a time - "there are no unbounded
   * collections" holds here too, since both of these are small by
   * construction: pending actions and the handful of devices watching.
   */
  async function list(path: string): Promise<Array<{ id: string; data: DocData }>> {
    const res = await fetchImpl(documentUrl(opts.projectId, path), {
      headers: authHeader(opts.idToken()),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new FirestoreRequestFailed(`could not list ${path}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { documents?: Array<{ name: string; fields?: FirestoreFields }> };
    return (body.documents ?? []).map((doc) => ({
      id: doc.name.slice(doc.name.lastIndexOf("/") + 1),
      data: fromFields(doc.fields),
    }));
  }

  return { set, get, remove, list };
}

export type FirestoreClient = ReturnType<typeof firestoreClient>;
