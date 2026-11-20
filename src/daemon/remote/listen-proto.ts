/**
 * Just enough protobuf to speak `google.firestore.v1.Firestore/Listen`.
 *
 * Hand-written rather than generated: the daemon needs to *write* one message
 * (`ListenRequest`, with an add or remove target) and *read* one
 * (`ListenResponse`), and both are a handful of fields. A generated client
 * would pull in protobufjs and the whole googleapis proto tree to carry what
 * fits in this file. Field numbers are from `google/firestore/v1/firestore.proto`,
 * `query.proto`, `document.proto` and `write.proto` - each one is named next
 * to its number below so a mismatch is checkable against the published protos.
 *
 * Decoded documents come back in the same shape `firestore-rest.ts` decodes
 * REST responses into (`DecodedDoc`), so nothing above this file can tell a
 * pushed document from a polled one.
 */
import type { DecodedDoc, DecodedValue } from "./firestore-rest.js";

// ---------------------------------------------------------------- writing

class Writer {
  private chunks: Buffer[] = [];

  private varint(value: number | bigint): void {
    let v = BigInt.asUintN(64, BigInt(value));
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.chunks.push(Buffer.from(bytes));
  }

  private tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  int(field: number, value: number): this {
    if (value === 0) return this;
    this.tag(field, 0);
    this.varint(value);
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, 2);
    this.varint(value.length);
    this.chunks.push(Buffer.from(value));
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  message(field: number, inner: Writer): this {
    return this.bytes(field, inner.finish());
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** What the daemon listens to: one document by path, or every document
 * directly under one collection. */
export type ListenTarget =
  | { kind: "document"; name: string }
  | { kind: "collection"; parent: string; collectionId: string };

export interface AddTarget {
  targetId: number;
  target: ListenTarget;
  /** From the last `TargetChange` for this target - lets a reconnect pick up
   * where the previous stream left off instead of re-reading (and being
   * billed for) every document again. */
  resumeToken?: Uint8Array;
}

/** `ListenRequest { string database = 1; Target add_target = 2; int32 remove_target = 3; }` */
export function encodeListenRequest(
  database: string,
  change: { add: AddTarget } | { remove: number },
): Buffer {
  const req = new Writer().string(1, database);
  if ("remove" in change) return req.int(3, change.remove).finish();

  const { targetId, target, resumeToken } = change.add;
  // `Target { QueryTarget query = 2; DocumentsTarget documents = 3;
  //   bytes resume_token = 4; int32 target_id = 5; }`
  const t = new Writer();
  if (target.kind === "document") {
    // `DocumentsTarget { repeated string documents = 2; }`
    t.message(3, new Writer().string(2, target.name));
  } else {
    // `QueryTarget { string parent = 1; StructuredQuery structured_query = 2; }`
    // `StructuredQuery { repeated CollectionSelector from = 2; }`
    // `CollectionSelector { string collection_id = 2; }`
    const from = new Writer().string(2, target.collectionId);
    const query = new Writer().message(2, from);
    t.message(2, new Writer().string(1, target.parent).message(2, query));
  }
  if (resumeToken && resumeToken.length > 0) t.bytes(4, resumeToken);
  t.int(5, targetId);
  return req.message(2, t).finish();
}

// ---------------------------------------------------------------- reading

interface Field {
  field: number;
  wireType: number;
  /** For wire type 0. */
  varint?: bigint;
  /** For wire type 2. */
  bytes?: Buffer;
  /** For wire type 1. */
  fixed64?: Buffer;
}

function* fields(buf: Buffer): Generator<Field> {
  let pos = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error("truncated varint");
      const byte = buf[pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wireType = key & 7;
    switch (wireType) {
      case 0: yield { field, wireType, varint: readVarint() }; break;
      case 1: yield { field, wireType, fixed64: buf.subarray(pos, pos + 8) }; pos += 8; break;
      case 2: {
        const len = Number(readVarint());
        if (pos + len > buf.length) throw new Error("truncated length-delimited field");
        yield { field, wireType, bytes: buf.subarray(pos, pos + len) };
        pos += len;
        break;
      }
      case 5: pos += 4; break;
      default: throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

function int32(v: bigint | undefined): number {
  return Number(BigInt.asIntN(32, v ?? 0n));
}

/** Packed or not - proto3 encoders pack repeated scalars, but a parser is
 * required to accept both. */
function pushInts(out: number[], f: Field): void {
  if (f.wireType === 0) { out.push(int32(f.varint)); return; }
  if (f.wireType === 2 && f.bytes) {
    for (const inner of packedVarints(f.bytes)) out.push(int32(inner));
  }
}

function* packedVarints(buf: Buffer): Generator<bigint> {
  let pos = 0;
  while (pos < buf.length) {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    yield result;
  }
}

/** `Timestamp { int64 seconds = 1; int32 nanos = 2; }`, as epoch millis. */
function decodeTimestamp(buf: Buffer): number {
  let seconds = 0n;
  let nanos = 0;
  for (const f of fields(buf)) {
    if (f.field === 1) seconds = BigInt.asIntN(64, f.varint ?? 0n);
    else if (f.field === 2) nanos = int32(f.varint);
  }
  return Number(seconds) * 1000 + Math.floor(nanos / 1e6);
}

/**
 * `Value` - decoded to the same subset `firestore-rest.ts` reads: strings,
 * numbers, timestamps (as millis) and maps. `undefined` for everything else
 * (null, booleans, bytes, references, geo points, arrays), which the caller
 * drops, exactly as the REST decoder ignores those types.
 *
 * `boolean_value = 1; integer_value = 2; double_value = 3;
 *  reference_value = 5; map_value = 6; geo_point_value = 8;
 *  array_value = 9; timestamp_value = 10; null_value = 11;
 *  string_value = 17; bytes_value = 18;`
 */
function decodeValue(buf: Buffer): DecodedValue | undefined {
  let value: DecodedValue | undefined;
  for (const f of fields(buf)) {
    if (f.field === 2) value = Number(BigInt.asIntN(64, f.varint ?? 0n));
    else if (f.field === 3 && f.fixed64) value = f.fixed64.readDoubleLE(0);
    else if (f.field === 17 && f.bytes) value = f.bytes.toString("utf8");
    else if (f.field === 10 && f.bytes) value = decodeTimestamp(f.bytes);
    else if (f.field === 6 && f.bytes) value = decodeMapValue(f.bytes);
    else value = undefined;
  }
  return value;
}

/** A `map<string, Value>` entry: `{ string key = 1; Value value = 2; }`. */
function addEntry(out: DecodedDoc, entry: Buffer): void {
  let key: string | null = null;
  let value: DecodedValue | undefined;
  for (const f of fields(entry)) {
    if (f.field === 1 && f.bytes) key = f.bytes.toString("utf8");
    else if (f.field === 2 && f.bytes) value = decodeValue(f.bytes);
  }
  if (key !== null && value !== undefined) out[key] = value;
}

/** `MapValue { map<string, Value> fields = 1; }` */
function decodeMapValue(buf: Buffer): DecodedDoc {
  const out: DecodedDoc = {};
  for (const f of fields(buf)) if (f.field === 1 && f.bytes) addEntry(out, f.bytes);
  return out;
}

export interface ListenDocument {
  /** Full resource name: `projects/{p}/databases/(default)/documents/...`. */
  name: string;
  data: DecodedDoc;
}

/** `Document { string name = 1; map<string, Value> fields = 2; }` */
function decodeDocument(buf: Buffer): ListenDocument {
  let name = "";
  const data: DecodedDoc = {};
  for (const f of fields(buf)) {
    if (f.field === 1 && f.bytes) name = f.bytes.toString("utf8");
    else if (f.field === 2 && f.bytes) addEntry(data, f.bytes);
  }
  return { name, data };
}

export const TargetChangeType = { NO_CHANGE: 0, ADD: 1, REMOVE: 2, CURRENT: 3, RESET: 4 } as const;

export type ListenResponse =
  | {
      kind: "targetChange";
      type: number;
      targetIds: number[];
      cause: { code: number; message: string } | null;
      resumeToken: Buffer | null;
    }
  | { kind: "documentChange"; document: ListenDocument; targetIds: number[]; removedTargetIds: number[] }
  | { kind: "documentDelete"; name: string; removedTargetIds: number[] }
  | { kind: "documentRemove"; name: string; removedTargetIds: number[] }
  | { kind: "filter"; targetId: number; count: number }
  | { kind: "unknown" };

/**
 * `ListenResponse { TargetChange target_change = 2; DocumentChange document_change = 3;
 *   DocumentDelete document_delete = 4; ExistenceFilter filter = 5; DocumentRemove document_remove = 6; }`
 */
export function decodeListenResponse(buf: Buffer): ListenResponse {
  for (const f of fields(buf)) {
    if (!f.bytes) continue;
    switch (f.field) {
      case 2: return decodeTargetChange(f.bytes);
      case 3: return decodeDocumentChange(f.bytes);
      case 4: return { kind: "documentDelete", ...decodeDocumentGone(f.bytes, 6) };
      case 5: return decodeFilter(f.bytes);
      case 6: return { kind: "documentRemove", ...decodeDocumentGone(f.bytes, 2) };
    }
  }
  return { kind: "unknown" };
}

/** `TargetChange { TargetChangeType target_change_type = 1; repeated int32 target_ids = 2;
 *   google.rpc.Status cause = 3; bytes resume_token = 4; }`
 * `Status { int32 code = 1; string message = 2; }` */
function decodeTargetChange(buf: Buffer): ListenResponse {
  let type = 0;
  const targetIds: number[] = [];
  let cause: { code: number; message: string } | null = null;
  let resumeToken: Buffer | null = null;
  for (const f of fields(buf)) {
    if (f.field === 1) type = int32(f.varint);
    else if (f.field === 2) pushInts(targetIds, f);
    else if (f.field === 3 && f.bytes) {
      let code = 0;
      let message = "";
      for (const s of fields(f.bytes)) {
        if (s.field === 1) code = int32(s.varint);
        else if (s.field === 2 && s.bytes) message = s.bytes.toString("utf8");
      }
      cause = { code, message };
    } else if (f.field === 4 && f.bytes) resumeToken = Buffer.from(f.bytes);
  }
  return { kind: "targetChange", type, targetIds, cause, resumeToken };
}

/** `DocumentChange { Document document = 1; repeated int32 target_ids = 5;
 *   repeated int32 removed_target_ids = 6; }` */
function decodeDocumentChange(buf: Buffer): ListenResponse {
  let document: ListenDocument = { name: "", data: {} };
  const targetIds: number[] = [];
  const removedTargetIds: number[] = [];
  for (const f of fields(buf)) {
    if (f.field === 1 && f.bytes) document = decodeDocument(f.bytes);
    else if (f.field === 5) pushInts(targetIds, f);
    else if (f.field === 6) pushInts(removedTargetIds, f);
  }
  return { kind: "documentChange", document, targetIds, removedTargetIds };
}

/** `DocumentDelete { string document = 1; repeated int32 removed_target_ids = 6; }`
 * `DocumentRemove { string document = 1; repeated int32 removed_target_ids = 2; }` */
function decodeDocumentGone(buf: Buffer, removedField: number): { name: string; removedTargetIds: number[] } {
  let name = "";
  const removedTargetIds: number[] = [];
  for (const f of fields(buf)) {
    if (f.field === 1 && f.bytes) name = f.bytes.toString("utf8");
    else if (f.field === removedField) pushInts(removedTargetIds, f);
  }
  return { name, removedTargetIds };
}

/** `ExistenceFilter { int32 target_id = 1; int32 count = 2; }` */
function decodeFilter(buf: Buffer): ListenResponse {
  let targetId = 0;
  let count = 0;
  for (const f of fields(buf)) {
    if (f.field === 1) targetId = int32(f.varint);
    else if (f.field === 2) count = int32(f.varint);
  }
  return { kind: "filter", targetId, count };
}

// ------------------------------------------------- test-only encoders
//
// The emulator test exercises the real decoder against real bytes; these let
// the unit tests build `ListenResponse` messages without a server.

export const forTests = {
  Writer,
};
