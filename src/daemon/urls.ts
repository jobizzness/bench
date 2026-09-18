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
  return cockpitOrigins(opts).map((origin) => `${origin}/?token=${opts.token}`);
}

/**
 * The same set without the token, for anything that is allowed to know where
 * the daemon answers but should not be handed the key with it.
 */
export function cockpitOrigins(opts: {
  host: string;
  port: number;
  interfaces?: () => Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>;
}): string[] {
  const loopback = `http://127.0.0.1:${opts.port}`;
  if (isLoopback(opts.host)) return [loopback];

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
  return [loopback, ...addresses.map((address) => `http://${address}:${opts.port}`)];
}

// Said plainly and once. The token is the whole of the authentication,
// it travels in the URL over plain HTTP, and a specialist has a full
// shell - so anyone on this network holding it can run anything here.
const NETWORK_WARNING =
  "bench: reachable on this network. The token in that URL is the only thing"
  + " standing in front of a shell on this machine.";

/**
 * The startup print for where the cockpit answers.
 *
 * The daemon can be up before the network is - under WSL `eth0` arriving
 * seconds late is normal - so a wide bind that sees only loopback keeps
 * polling and prints the LAN addresses as they appear, rather than a URL
 * list that is wrong before the ink dries.
 */
export function announceCockpitUrls(opts: {
  host: string;
  port: number;
  token: string;
  interfaces?: () => Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>;
  write: (line: string) => void;
  pollMs?: number;
  giveUpMs?: number;
}): { stop(): void } {
  const printed = new Set<string>();
  const announce = (): boolean => {
    let sawNetwork = false;
    for (const url of cockpitUrls(opts)) {
      if (printed.has(url)) continue;
      printed.add(url);
      opts.write(`bench: ${url}`);
      if (!url.startsWith("http://127.0.0.1:")) sawNetwork = true;
    }
    return sawNetwork;
  };

  if (announce()) {
    opts.write(NETWORK_WARNING);
    return { stop: () => {} };
  }
  if (isLoopback(opts.host)) return { stop: () => {} };

  opts.write("bench: bound to every interface, but no network is up yet - more addresses print as they appear.");

  const pollMs = opts.pollMs ?? 2000;
  const giveUpMs = opts.giveUpMs ?? 60_000;
  const interval = setInterval(() => {
    if (announce()) {
      opts.write(NETWORK_WARNING);
      stop();
    }
  }, pollMs);
  const giveUp = setTimeout(() => {
    opts.write(
      `bench: still no network address after ${giveUpMs / 1000}s`
      + " - Settings > Server lists addresses as they appear.",
    );
    stop();
  }, giveUpMs);
  interval.unref?.();
  giveUp.unref?.();

  const stop = () => {
    clearInterval(interval);
    clearTimeout(giveUp);
  };
  return { stop };
}
