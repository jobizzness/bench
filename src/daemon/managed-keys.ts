import { isOauthToken, type KeyCheck, type ManagedKey } from "./anthropic-key.js";
import type { Usage } from "./usage.js";

/**
 * How long a key reported exhausted stays cooled down when the API never
 * said when its window turns over. Shared by the routes that check a synced
 * list and by the daemon's own profile sync, which re-checks a stale key on
 * the same clock.
 */
export const RECHECK_AFTER = 15 * 60_000;

/**
 * Check each credential a profile syncs down and keep the verdict.
 *
 * A key that was reported exhausted stays exhausted until its window turns
 * over - or for fifteen minutes when the API never said when that is -
 * regardless of what the check says now: the check is one request, the
 * limit it ran into is not. Both managed key lists follow the same rule.
 */
export async function checkManaged(input: unknown[], deps: {
  check: (key: string) => Promise<KeyCheck>;
  usageOf: (key: string) => Promise<Usage>;
  fallbackLabel: string;
  now?: () => number;
}): Promise<ManagedKey[]> {
  const now = deps.now ?? Date.now;
  const checked = await Promise.all(input.map(async (item: unknown) => {
    const value = item as Record<string, unknown>;
    const id = String(value.id ?? "");
    const key = String(value.key ?? "").trim();
    const label = String(value.label ?? deps.fallbackLabel);
    const priorStatus = String(value.status ?? "unchecked");
    const priorCheckedAt = Number(value.checkedAt ?? 0);
    if (id === "" || key === "") return null;
    const at = now();
    const priorResetsAt = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : NaN;
    const coolingDown = priorStatus === "exhausted"
      && (Number.isFinite(priorResetsAt) ? at < priorResetsAt : at - priorCheckedAt < RECHECK_AFTER);
    if (coolingDown) {
      return {
        id, key, label, status: "exhausted", checkedAt: priorCheckedAt,
        resetsAt: Number.isFinite(priorResetsAt) ? String(value.resetsAt) : null,
      } as ManagedKey;
    }
    const verdict = await deps.check(key);
    const next: ManagedKey = {
      id, key, label,
      status: verdict === "ok" ? "available" : verdict,
      checkedAt: at,
    };
    // Only a setup-token has windows to spend. A key whose window is full
    // is exhausted whether or not the plain check could tell.
    if (verdict === "ok" && isOauthToken(key)) {
      const usage = await deps.usageOf(key);
      if (usage.available) {
        next.usage = usage.windows;
        const full = usage.windows.filter((window) => window.percent >= 100);
        if (full.length > 0) {
          next.status = "exhausted";
          next.resetsAt = full.map((window) => window.resetsAt).filter((at): at is string => at !== null).sort()[0] ?? null;
        }
      }
    }
    return next;
  }));
  return checked.filter((item): item is ManagedKey => item !== null);
}
