/**
 * Who a push goes to, and what it says - kept free of firebase-admin so the
 * daemon's own test suite can exercise it (tests/push-plan.test.ts).
 */

/** A device that switched notifications on, at users/{uid}/devices/{id}. */
export interface Device { id: string; token: string }

/** One entry of users/{uid}/machines/{mid}/presence/state's `viewers` map. */
export interface Viewer { at: number; watching: string }

/** What the daemon asks for, at users/{uid}/machines/{mid}/notify/{id}. */
export interface Request { sessionId: string; kind: string; title: string; body: string; at: number }

/** The daemon's own staleness window for a viewer (presence.ts). */
export const VIEWER_STALE_MS = 3 * 60_000;

/** A request older than this is news nobody wants any more - a daemon that
 * wrote it while the function was down, say. */
export const TOO_OLD_MS = 10 * 60_000;

/**
 * The tokens to send to: every device except one that has this very tab open
 * right now - it is already looking at what the notification would say.
 */
export function recipients(devices: Device[], viewers: Record<string, Viewer>, sessionId: string, now: number): Device[] {
  return devices.filter((device) => {
    const viewer = viewers[device.id];
    const looking = viewer !== undefined && now - viewer.at < VIEWER_STALE_MS && viewer.watching === sessionId;
    return !looking;
  });
}

/** The data payload. Data-only, so the cockpit's own service worker draws it
 * (sw.ts) and decides what a tap opens. Strings only - FCM's rule. */
export function payload(request: Request): Record<string, string> {
  return {
    title: request.title,
    body: request.body,
    url: `/s/${request.sessionId}`,
    // One notification per tab: a newer one replaces the last rather than
    // stacking a pile of them for the same specialist.
    tag: `bench-${request.sessionId}`,
    kind: request.kind,
  };
}

/** FCM's answers that mean a token is dead and should be forgotten. */
export function isDeadToken(code: string | undefined): boolean {
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
}
