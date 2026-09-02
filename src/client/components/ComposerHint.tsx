import type { ReactNode } from "react";

const Key = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/**
 * What the keyboard will do right now. It says nothing at all when there is
 * nothing to press — a line of shortcuts under an ordinary message box is
 * noise, and worse, a claim that is not true.
 */
export function ComposerHint({ kind, optionCount = 0 }: {
  kind: "none" | "working" | "intake" | "options" | "reply";
  /** How high the number keys go, so the hint cannot promise a key that does nothing. */
  optionCount?: number;
}) {
  return (
    // `data-kind` lets the stylesheet drop the "intake"/"options" variants
    // below the width breakpoint - they are keyboard shortcuts
    // (useDecisionKeys.ts) for keys a touchscreen does not have, and the
    // decision buttons are already thumb-sized there without them.
    <p id="composer-hint" data-kind={kind}>
      {kind === "working" && "Working — a message queues and is answered when this turn ends."}
      {kind === "reply" && (
        <>
          <Key>↵</Key>{" send  "}
          <Key>⇧↵</Key>{" new line"}
        </>
      )}
      {kind === "intake" && (
        <>
          <Key>1</Key>–<Key>9</Key>{" pick  "}
          <Key>↑</Key><Key>↓</Key>{" move  "}
          <Key>↵</Key>{" send  "}
          <Key>/</Key>{" type instead"}
        </>
      )}
      {kind === "options" && (
        <>
          <Key>1</Key>–<Key>{optionCount}</Key>{" to pick  "}
          <Key>↵</Key>{" to confirm  "}
          <Key>/</Key>{" to type instead"}
        </>
      )}
    </p>
  );
}
