/**
 * The one seam every payload crosses on its way to or from Firestore - a
 * command's body, a result's body, a mirror document's contents.
 *
 * This slice implements it as identity: `encode` serialises to JSON and
 * `decode` parses it back, so what lands in Firestore is the payload in the
 * clear. See "Content in the cloud" in
 * `docs/superpowers/specs/2026-08-31-bench-over-firestore-design.md` - the
 * seam exists so #48 (end-to-end encryption) is a change to this one file
 * rather than to every place a payload crosses the wire.
 */
export function encode(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}
