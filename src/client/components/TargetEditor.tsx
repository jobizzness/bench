import { projectName } from "../format.js";
import { useTargetEditor, type TargetOutcome } from "./useTargetEditor.js";

/**
 * What the button says after it has been pressed.
 *
 * "no editor" is the one that earns its place. The developer opens VS Code
 * themselves, so nothing listening is an ordinary state rather than an
 * error - and a button that drew the same tick either way would be lying
 * about the only outcome worth knowing about.
 */
const SAID: Record<TargetOutcome, string> = {
  idle: "editor",
  sending: "…",
  sent: "pointed",
  nobody: "no editor",
  failed: "failed",
};

/**
 * Points an open VS Code window at this project (#129).
 *
 * It does not launch anything. The extension is already connected to the
 * daemon; this tells it which project this window is for, which matters when
 * one bench serves several and a window has more than one folder open.
 */
export function TargetEditor({ project }: { project: string }) {
  const { outcome, target } = useTargetEditor(project);

  return (
    <button
      type="button"
      className="target-editor"
      data-outcome={outcome}
      title={`Point an open VS Code window at ${projectName(project)}`}
      aria-label={`Point an open VS Code window at ${projectName(project)}`}
      disabled={outcome === "sending"}
      onClick={(event) => {
        // Inside a summary, a click is a fold unless it is stopped.
        event.preventDefault();
        event.stopPropagation();
        target();
      }}
    >
      {SAID[outcome]}
    </button>
  );
}
