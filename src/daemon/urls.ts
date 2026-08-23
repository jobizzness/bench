import { networkInterfaces } from "node:os";

/** Addresses that only mean anything on this machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * Every address the cockpit can actually be opened at.
 *
 * Bound to loopback there is one answer and it is the one printed today.
 * Bound wider, "http://0.0.0.0:7420" is not an address anyone can type, and
 * the developer opening it from a phone needs the one that reaches this
 * machine - so the interfaces are enumerated and listed.
 */
export function cockpitUrls(opts: {
  host: string;
  port: number;
  token: string;
  interfaces?: () => Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>;
}): string[] {
  const query = `/?token=${opts.token}`;

  if (isLoopback(opts.host)) return [`http://127.0.0.1:${opts.port}${query}`];

  const read = opts.interfaces ?? (networkInterfaces as unknown as NonNullable<typeof opts.interfaces>);
  const addresses: string[] = [];
  for (const entries of Object.values(read())) {
    for (const entry of entries ?? []) {
      // IPv4 only: an address someone has to type on another device.
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.push(entry.address);
    }
  }

  // Loopback still works when bound wide, and it stays first because it is
  // the one that needs no network at all.
  return [`http://127.0.0.1:${opts.port}${query}`,
    ...addresses.map((address) => `http://${address}:${opts.port}${query}`)];
}
