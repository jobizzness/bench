import { useEffect, useRef, type RefObject } from "react";
import { DISMISS_DISTANCE, findScrollableAncestor, isOutsideDialog, pastDismissThreshold } from "./sheetGesture.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

/**
 * Scrim-tap and swipe-to-dismiss for a bottom `.sheet` dialog (#91), built
 * once so any `.sheet` can pick it up rather than each dialog reimplementing
 * it - the same reasoning #81 gave the bottom-sheet CSS itself. Wired into
 * `DecisionSheet` only for now; see that component's own note on why the
 * other `.sheet` dialogs (intake, dispatch, settings, new-session) were left
 * alone.
 *
 * Two gestures:
 *
 * **Tap the scrim.** A `<dialog>` reports a backdrop click as a click on the
 * dialog element itself (`event.target === dialog`) - the only way to tell
 * that apart from a click that lands on the dialog's own box (its padding,
 * or a spot no child covers) is whether the coordinates fall outside its
 * `getBoundingClientRect()` (`isOutsideDialog`). That alone is not enough: a
 * `click` fires on the nearest common ancestor of where the pointer went
 * down and where it came up, so a drag that starts on a child inside the
 * sheet and is released over the backdrop would also report
 * `target === dialog` at the coordinates it ended on - outside the rect,
 * which would misread as a scrim tap. `pointerdown` is tracked separately so
 * the close only fires when the *press itself* already landed on the dialog
 * element (the backdrop), not merely the release.
 *
 * **Drag the sheet down.** A single touch is tracked from `touchstart`. Past
 * the first ~8px of movement the gesture commits to an axis, and - if that
 * axis is vertical and downward - to being either a sheet-drag or a
 * content-scroll, decided once and never switched mid-drag:
 *
 *   - starting on the grabber (`.sheet-grabber`) always drags the sheet,
 *     regardless of scroll position;
 *   - starting anywhere else drags the sheet only if the nearest scrollable
 *     ancestor (`findScrollableAncestor`) was already at `scrollTop === 0`
 *     when the touch began. Otherwise the touch is left alone - no
 *     `preventDefault`, no transform - and the browser scrolls the content.
 *     That is the whole ask: a drag that begins while the sheet is scrolled
 *     must scroll the content, not fight it for the same gesture.
 *
 * Released past `DISMISS_DISTANCE` or `DISMISS_VELOCITY`, the sheet finishes
 * leaving - so the exit reads as one continuous motion, not a jump-cut -
 * before `onClose` fires. Short of both, it springs back to `transform: none`
 * and stays open. The motion is driven by inline `transform`/`transition`
 * set here, from the gesture's own tracked state, never by a CSS
 * `animation:` - the trap already paid for twice (#79, #82): this dialog
 * only goes from not-rendered to rendered on `showModal()`/`close()`, never
 * on a pane swap, so nothing replays an `animation:` by accident here, but
 * there is still no reason to let the two mechanisms compete for the same
 * property. `prefers-reduced-motion: reduce` skips the transition and closes
 * (or springs back) at once, checked fresh at release rather than cached, on
 * every route including the drag.
 *
 * Gated on `useNarrowViewport` - the same breakpoint `styles.css` itself
 * switches a `.sheet` to a bottom sheet at. Above it the dialog is centred,
 * not a thing anyone swipes away, and "above 720px nothing changes" (#91) is
 * a criterion, not a suggestion: without this gate, clicking outside a
 * centred desktop dialog would newly close it, which nobody asked for and
 * which the same click handler cannot tell apart from a developer who
 * genuinely meant to dismiss it.
 */
export function useSheetDismissGestures(
  dialogRef: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const narrow = useNarrowViewport();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !narrow) return;

    const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Only a press that itself started on the dialog element (the backdrop,
    // not a descendant) can turn into a scrim dismiss - see the class doc.
    let downOnBackdrop = false;
    const onPointerDown = (event: PointerEvent) => { downOnBackdrop = event.target === dialog; };
    const onScrimClick = (event: MouseEvent) => {
      if (!downOnBackdrop || event.target !== dialog) return;
      if (isOutsideDialog(event.clientX, event.clientY, dialog.getBoundingClientRect())) onCloseRef.current();
    };

    type Phase = "idle" | "pending" | "dragging" | "scrolling";
    let phase: Phase = "idle";
    let startedAtTop = false;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let lastY = 0;
    let lastTime = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (!dialog.open || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const target = touch.target as Element;
      const fromGrabber = target.closest(".sheet-grabber") !== null;
      startedAtTop = fromGrabber || findScrollableAncestor(target, dialog).scrollTop <= 0;
      startX = touch.clientX;
      startY = lastY = touch.clientY;
      startTime = lastTime = event.timeStamp;
      phase = "pending";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (phase === "idle" || phase === "scrolling") return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (phase === "pending") {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const verticalDown = Math.abs(dy) > Math.abs(dx) && dy > 0;
        // Sideways, upward, or a downward pull that did not begin at the top
        // of the scroll: the content's own gesture, not the sheet's. Leave
        // it alone entirely rather than only sometimes calling preventDefault.
        if (!verticalDown || !startedAtTop) { phase = "scrolling"; return; }
        phase = "dragging";
        dialog.style.transition = "";
      }
      if (phase !== "dragging") return;

      event.preventDefault(); // stop the page/dialog rubber-banding under the drag
      lastY = touch.clientY;
      lastTime = event.timeStamp;
      dialog.style.transform = `translateY(${Math.max(0, dy)}px)`;
    };

    const springBack = () => {
      if (reducedMotion()) { dialog.style.transform = ""; return; }
      dialog.style.transition = "transform var(--duration-enter) var(--ease-enter)";
      dialog.style.transform = "translateY(0px)";
      const clear = () => { dialog.style.transition = ""; dialog.style.transform = ""; };
      dialog.addEventListener("transitionend", clear, { once: true });
    };

    const dismiss = () => {
      if (reducedMotion()) {
        dialog.style.transform = "";
        dialog.style.transition = "";
        onCloseRef.current();
        return;
      }
      const rect = dialog.getBoundingClientRect();
      dialog.style.transition = "transform var(--duration-scene) var(--ease-exit)";
      dialog.style.transform = `translateY(${rect.height}px)`;
      dialog.addEventListener("transitionend", () => {
        // Cleared before `onClose`, not after, and not left for the next
        // opener to deal with: `DecisionSheet` stays mounted across open and
        // close, so this is the same element every time. Leaving the exit
        // transform on it meant the next decision opened a full sheet-height
        // below the viewport - the `::backdrop` is not affected by the
        // dialog's own transform, so what the developer got was a dimmed
        // roster with nothing on top of it, and it stayed that way until a
        // reload (#94).
        dialog.style.transition = "";
        dialog.style.transform = "";
        onCloseRef.current();
      }, { once: true });
    };

    const onTouchEnd = () => {
      if (phase !== "dragging") { phase = "idle"; return; }
      phase = "idle";
      const distance = Math.max(0, lastY - startY);
      const elapsed = Math.max(1, lastTime - startTime);
      if (pastDismissThreshold(distance, distance / elapsed)) dismiss(); else springBack();
    };

    const onTouchCancel = () => {
      const wasDragging = phase === "dragging";
      phase = "idle";
      if (wasDragging) springBack();
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("click", onScrimClick);
    dialog.addEventListener("touchstart", onTouchStart, { passive: true });
    dialog.addEventListener("touchmove", onTouchMove, { passive: false });
    dialog.addEventListener("touchend", onTouchEnd);
    dialog.addEventListener("touchcancel", onTouchCancel);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("click", onScrimClick);
      dialog.removeEventListener("touchstart", onTouchStart);
      dialog.removeEventListener("touchmove", onTouchMove);
      dialog.removeEventListener("touchend", onTouchEnd);
      dialog.removeEventListener("touchcancel", onTouchCancel);
    };
    // `dialogRef` is a ref: it never changes identity across renders, and
    // `onClose` is read through `onCloseRef` above precisely so a caller that
    // does not memoize it (most do not - see `DecisionSheet`'s own `openRef`
    // for the established pattern here) does not tear these listeners down
    // and rebuild them on every unrelated re-render (a keystroke in the
    // answer field, mid-drag or not). `narrow` crossing the breakpoint is the
    // one thing that legitimately re-runs this, attaching or tearing the
    // gesture down to match.
  }, [dialogRef, narrow]);
}
