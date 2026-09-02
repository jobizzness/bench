/**
 * `crypto.randomUUID` only exists in a secure context - HTTPS, or
 * `localhost`. The cockpit is normally reached over plain HTTP on a LAN IP
 * (a phone or another machine hitting the daemon directly), which is not a
 * secure context, so the method is simply absent there and calling it
 * throws `TypeError: crypto.randomUUID is not a function`. `getRandomValues`
 * carries no such restriction, so it backs the fallback.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
