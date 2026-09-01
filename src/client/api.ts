import { currentEndpoint, saveEndpoint, socketUrl, type Endpoint } from "./endpoint.js";
import { currentTheme } from "./theme.js";
import { sendCommand } from "./remote-transport.js";
import { sessionIdIn } from "../shared/remote-paths.js";

/**
 * The daemon this page is talking to, resolved once on load.
 *
 * Kept in a variable rather than read per call so that every request in a
 * session goes to the same place: told a new address mid-flight, the cockpit
 * reloads rather than half-switching.
 */
let active: Endpoint | null = currentEndpoint();

export const endpoint = (): Endpoint | null => active;

/** Empty when the page has not been told where its daemon is. */
export const token = (): string => active?.token ?? "";

/** Same-origin when the daemon served this page; absolute when it did not. */
export const apiUrl = (path: string): string => `${active?.origin ?? ""}${path}`;

export const eventsUrl = (): string | null => (active ? socketUrl(active) : null);

/**
 * Whether the daemon is somewhere other than where this page came from -
 * which is to say, whether this is a hosted copy of the cockpit that was
 * told where to look. It changes what silence means: a daemon that served
 * this page and then stopped answering is restarting, and one that never
 * answered was probably the wrong address.
 */
export const isRemote = (): boolean => active !== null && active.origin !== location.origin;

/**
 * Point this browser at a daemon and start again there. A reload rather than
 * a re-render: the roster socket, the thread, the queue and the artifact
 * frame all read this, and half of them switching is a cockpit showing two
 * daemons at once.
 */
export function pointAt(next: Endpoint): void {
  saveEndpoint(next);
  active = next;
  location.reload();
}

/**
 * Which machine a call belongs to, and how that is decided.
 *
 * A transport belongs to a machine, not to the page: direct for the machine
 * that served this page (unchanged, everything above this comment), relayed
 * for every other machine on the account. Which machine a call is for
 * follows from the session it names - `useRoster.ts` is what knows that,
 * from the merged roster, and calls `routeSession` as it learns it. Nothing
 * else has to know: `authFetch` and `postJson` below are the only callers of
 * `machineFor`, and every one of the 45 call sites elsewhere is unchanged.
 */
export interface MachineRef {
  uid: string;
  machineId: string;
}

const sessionMachine = new Map<string, MachineRef>();
let activeMachine: MachineRef | null = null;

/** Called by `useRoster.ts` as the merged roster changes. A session with no
 * entry - every session on the machine that served this page - is local. */
export function routeSession(sessionId: string, machine: MachineRef | null): void {
  if (machine === null) sessionMachine.delete(sessionId);
  else sessionMachine.set(sessionId, machine);
}

/**
 * Which machine the machine-global routes - Settings, the API keys, the
 * project list, the spend meters - answer for. Follows the specialist
 * currently open, defaulting to local; see "Machine-global routes" in the
 * design. Set by `useRoster.ts` alongside `routeSession`, from the same
 * merged roster.
 */
export function setActiveMachine(machine: MachineRef | null): void {
  activeMachine = machine;
}

export function getActiveMachine(): MachineRef | null {
  return activeMachine;
}

function machineFor(path: string): MachineRef | null {
  const sessionId = sessionIdIn(path);
  if (sessionId !== null) return sessionMachine.get(sessionId) ?? null;
  return activeMachine;
}

/**
 * Every request that comes back unauthorised means the same thing, and the
 * page cannot recover from it by trying harder - so it is announced once and
 * whoever is showing the banner listens.
 */
export const STALE_EVENT = "bench:stale";

export function linkIsStale(): void {
  document.dispatchEvent(new Event(STALE_EVENT));
}

/**
 * Every request carries the cockpit token; a 401 means the link is stale.
 *
 * When the path names a session on another machine, this becomes a command
 * document and its result rather than a direct request - see `machineFor`
 * above and `remote-transport.ts`. The caller never has to know: both paths
 * end in a real `Response`, so every one of the 45 call sites elsewhere reads
 * `.ok`, `.status` and `.json()` exactly as before.
 */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const machine = machineFor(path);
  if (machine !== null) {
    const body = typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    const result = await sendCommand(machine.uid, machine.machineId, init?.method ?? "GET", path, body);
    return new Response(result.text, { status: result.status, headers: { "content-type": result.contentType } });
  }

  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "x-bench-token": token(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) linkIsStale();
  return res;
}

/**
 * An artifact is loaded by the browser into a frame, which cannot carry a
 * header - so this one URL wears the token in its query string.
 */
/**
 * A report is a separate document in a sandboxed frame, so no palette reaches
 * it by cascade. The theme rides on the URL and the daemon draws the page in
 * it - which is also why changing theme with a report open needs the frame to
 * reload, and it does, because the src changes.
 */
export const artifactUrl = (sessionId: string, seq: number, file: string): string =>
  apiUrl(`/r/${sessionId}/${seq}/${file}?token=${encodeURIComponent(token())}`
    + `&theme=${encodeURIComponent(currentTheme())}`);

export const postJson = (path: string, body: unknown): Promise<Response> =>
  authFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * A report either has a URL to hand an `<iframe>` (local: unchanged from
 * before) or has to be fetched as content and rendered with `srcdoc` (a
 * relayed machine, where there is no URL a browser can reach) - see
 * "`artifactUrl` changes rather than moves" in the design. The two callers,
 * `ArtifactDialog.tsx` and `ArtifactCard.tsx`, are the only places that need
 * to know which kind they got.
 */
export type ArtifactContent =
  | { kind: "url"; url: string }
  | { kind: "html"; html: string };

export async function loadArtifact(sessionId: string, seq: number, file: string): Promise<ArtifactContent> {
  const machine = sessionMachine.get(sessionId) ?? null;
  if (machine === null) return { kind: "url", url: artifactUrl(sessionId, seq, file) };

  const result = await sendCommand(
    machine.uid, machine.machineId, "GET",
    `/r/${sessionId}/${seq}/${file}?theme=${encodeURIComponent(currentTheme())}`,
    undefined,
  );
  return { kind: "html", html: result.text };
}
