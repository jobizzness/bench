/**
 * Which daemon this cockpit is for.
 *
 * Served by the daemon itself, the answer is "wherever this page came from"
 * and the token is in the URL. Served from anywhere else - a copy of the
 * client on static hosting, opened on a phone - the page has no idea where
 * the daemon is, and has to be told once and remember.
 */

export interface Endpoint {
  /** Scheme, host and port. No trailing slash. */
  origin: string;
  token: string;
}

const KEY = "bench:endpoint";

/** What a browser can be told about a daemon it cannot reach. */
export type Reach = "ok" | "unauthorized" | "unreachable";

/**
 * The link the daemon prints, which carries both halves: where it is, and
 * the token that opens it. Asking for the address and the token separately
 * would be asking someone to take one line apart by hand.
 */
export function parseCockpitLink(text: string): Endpoint | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    // A bare host:port is what people type when they are reading it off
    // another screen. Assume the scheme the daemon actually serves.
    url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }

  const token = url.searchParams.get("token") ?? "";
  if (token === "") return null;

  return { origin: url.origin, token };
}

/** The endpoint saved on this browser, if it has been told one. */
export function savedEndpoint(store: Storage = localStorage): Endpoint | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.origin === "string" && typeof parsed?.token === "string"
      ? { origin: parsed.origin, token: parsed.token }
      : null;
  } catch {
    // A browser with storage turned off is a cockpit that asks every time,
    // which is worse than this but not broken.
    return null;
  }
}

export function saveEndpoint(endpoint: Endpoint, store: Storage = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(endpoint));
  } catch {
    // Nothing to do about it, and the endpoint still works for this page.
  }
}

/**
 * Where this page should be talking to.
 *
 * The URL wins over anything remembered: opening the link the daemon just
 * printed is how you point the cockpit at a daemon, and it would be a poor
 * cockpit that ignored the address bar in favour of last week.
 */
export function currentEndpoint(
  where: { origin: string; search: string } = location,
  store: Storage = localStorage,
): Endpoint | null {
  const token = new URLSearchParams(where.search).get("token") ?? "";
  if (token !== "") return { origin: where.origin, token };
  return savedEndpoint(store);
}

/** The socket address for an endpoint: the same host, the other scheme. */
export function socketUrl(endpoint: Endpoint): string {
  const scheme = endpoint.origin.startsWith("https:") ? "wss:" : "ws:";
  const host = endpoint.origin.replace(/^https?:/, "");
  return `${scheme}${host}/events?token=${encodeURIComponent(endpoint.token)}`;
}

/**
 * Whether a daemon is there and will have us. Told apart from each other
 * because they need different things from the developer: a wrong address is
 * retyped, a stale token is fetched again from the terminal.
 */
export async function reach(endpoint: Endpoint, fetcher = fetch): Promise<Reach> {
  try {
    const res = await fetcher(`${endpoint.origin}/api/addresses`, {
      headers: { "x-bench-token": endpoint.token },
    });
    if (res.status === 401) return "unauthorized";
    return res.ok ? "ok" : "unreachable";
  } catch {
    // Refused, wrong port, asleep, or blocked by the browser for being plain
    // HTTP under an HTTPS page. From here they are the same silence.
    return "unreachable";
  }
}

/**
 * Whether to ask the developer where Bench is.
 *
 * Silence means different things depending on who is being silent. A daemon
 * that served this very page and has stopped answering is being restarted,
 * and asking for its address would be asking about a machine that is right
 * here. A daemon that was typed in and has never once answered is usually
 * the wrong address - and that is a question worth interrupting for.
 *
 * A page that knows no daemon but is signed into Firebase is not lost: the
 * merged roster and every command from here on ride over Firestore, and no
 * address is coming. That is the phone's normal state, not a gap to fill -
 * see "The phone's first screen is sign-in, not 'Where is Bench running?'"
 * in the design. `SignIn` is what such a page shows instead.
 */
export function shouldAskForServer(state: {
  /** Whether this page knows of any daemon at all. */
  known: boolean;
  /** The socket: null while it is still coming up. */
  live: boolean | null;
  /** Whether it has ever been up since the page loaded. */
  everConnected: boolean;
  /** Whether the daemon is somewhere other than where this page came from. */
  remote: boolean;
  /** Whether this browser holds a signed-in Firebase user. */
  signedIn: boolean;
}): boolean {
  if (!state.known) return !state.signedIn;
  return state.remote && state.live === false && !state.everConnected;
}
