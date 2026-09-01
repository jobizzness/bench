/**
 * An in-memory stand-in for the Firestore REST API, at the `fetch` boundary -
 * the same trick `tests/remote-controller.test.ts` uses for `firestore-rest.ts`,
 * extended to answer collection `list()` calls as well as single-document
 * `set`/`get`/`remove`. No test in this suite touches the network; this is
 * what makes that true for anything built on `firestoreClient()`.
 */

type WireValue = { stringValue: string } | { integerValue: string };
type WireFields = Record<string, WireValue>;
type DocData = Record<string, string | number>;

function toWireFields(data: DocData): WireFields {
  const fields: WireFields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = typeof value === "number"
      ? { integerValue: String(Math.trunc(value)) }
      : { stringValue: value };
  }
  return fields;
}

function fromWireFields(fields: WireFields | undefined): DocData {
  const data: DocData = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    data[key] = "integerValue" in value ? Number(value.integerValue) : value.stringValue;
  }
  return data;
}

export function fakeFirestore() {
  const docs = new Map<string, DocData>();
  const writes: string[] = [];
  const deletes: string[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).split("/documents/")[1] ?? "").replace(/\?.*$/, "");
    const method = init?.method ?? "GET";

    if (method === "PATCH") {
      docs.set(path, fromWireFields(JSON.parse(String(init?.body)).fields));
      writes.push(path);
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") {
      docs.delete(path);
      deletes.push(path);
      return new Response("{}", { status: 200 });
    }

    // A document path has an even number of segments (collection/doc/collection/doc/...);
    // a collection path has an odd number - the same convention Firestore itself uses.
    const isCollection = path.split("/").filter(Boolean).length % 2 === 1;
    if (!isCollection) {
      const data = docs.get(path);
      if (!data) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ fields: toWireFields(data) }), { status: 200 });
    }

    const prefix = path === "" ? "" : `${path}/`;
    const documents = [...docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map(([p, data]) => ({ name: `projects/x/databases/(default)/documents/${p}`, fields: toWireFields(data) }));
    return new Response(JSON.stringify({ documents }), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, docs, writes, deletes };
}
