import type { SelfUpdate } from "./useSelfUpdate.js";

/**
 * Absent entirely when the checkout is level with its remote and nothing is
 * pending - a button that says "nothing to do" is one that has to be read
 * before it can be ignored, the same rule `open-queue` follows next to it
 * (#146).
 */
export function UpdateButton({ self }: { self: SelfUpdate }) {
  if (self.kind === null) return null;

  const title = self.kind === "update"
    ? (self.busy ? "Pulling and building…" : `${self.behind} commit${self.behind === 1 ? "" : "s"} behind origin`)
    : (self.busy ? "Restarting once turns are done…" : "Restart to run the code just built");

  const label = self.kind === "update"
    ? (self.busy ? "Updating…" : "Update")
    : (self.busy ? "Restarting…" : "Restart");

  return (
    <button
      id="self-update"
      type="button"
      disabled={self.busy}
      title={title}
      aria-label={title}
      onClick={self.onTap}
    >
      {label}
    </button>
  );
}
