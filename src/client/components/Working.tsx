import type { PlanStep } from "../../daemon/plan.js";
import type { RosterRow } from "../../shared/types.js";
import { elapsedSince, formatTokens, hashOf } from "../format.js";
import { useBenchState } from "./context.js";
import { StopTurn } from "./StopTurn.js";
import { useTick } from "./useTick.js";

// Deliberately unhurried words. A specialist is reading and thinking, not
// spinning - the copy should say so without pretending to know what it is
// doing at any instant.
const VERBS = [
  "Reading", "Tracing", "Rummaging", "Untangling", "Cross-checking",
  "Squinting", "Collating", "Whittling", "Deliberating", "Circling back",
  "Following a hunch", "Second-guessing", "Reconsidering", "Digging",
];
const GLYPHS = ["✢", "✦", "✧", "✶"];

function meta(row: RosterRow): string {
  const parts: string[] = [];
  if (row.startedAt) parts.push(elapsedSince(row.startedAt));

  const tokens = formatTokens(row.tokens);
  if (tokens) parts.push(`↓ ${tokens}`);

  // What it is running, and when it last ran anything, used to be repeated
  // here. The trail's summary line says both a few inches up the page now,
  // and saying it twice made neither copy worth reading.
  return parts.join("  ·  ");
}

/**
 * How far through its own checklist a specialist is, or null when there is
 * nothing honest to draw.
 *
 * Nothing when every step is done, which is not the boast it looks like: the
 * daemon falls back to the most recent plan on disk when this turn has not
 * written one, so a full bar at the start of a turn is last turn's bar. A
 * bar that only ever appears while there is something left to do cannot tell
 * that lie, and the sweep covers the rest.
 */
export function fractionDone(steps: PlanStep[] | null): number | null {
  if (!steps || steps.length === 0) return null;
  const done = steps.filter((step) => step.state === "done").length;
  return done < steps.length ? done / steps.length : null;
}

export function Working({ steps }: { steps: PlanStep[] | null }) {
  const { rows, selectedId } = useBenchState();
  const tick = useTick();
  const row = rows.find((r) => r.id === selectedId);

  if (!row || (row.status !== "working" && row.status !== "provisioning")) return null;

  // The verb changes slowly, and is seeded per specialist so two working at
  // once do not say the same thing.
  const verb = row.status === "provisioning"
    ? "Preparing worktree"
    : VERBS[(hashOf(row.id) + Math.floor(tick / 24)) % VERBS.length];

  const fraction = fractionDone(steps);
  const done = steps?.filter((step) => step.state === "done").length ?? 0;

  return (
    <div id="working" data-measured={fraction !== null}>
      {fraction !== null && (
        <div
          id="working-progress"
          style={{ width: `${Math.round(fraction * 100)}%` }}
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={steps!.length}
        />
      )}
      <span id="working-glyph" aria-hidden="true">{GLYPHS[tick % GLYPHS.length]}</span>
      <span id="working-verb">{verb}</span>
      <span id="working-meta">
        {fraction !== null && <span id="working-steps">{done} of {steps!.length}</span>}
        {meta(row)}
      </span>
      {/* Only while there is a turn to end. Provisioning is a worktree being
          built, and stopping that leaves half a checkout behind. */}
      {row.status === "working" && <StopTurn id={row.id} />}
    </div>
  );
}
