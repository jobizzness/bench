import { useEffect, useRef, type RefObject } from "react";

/**
 * Wires a pointer drag on the roster's handle to `setWidth` (#145). The
 * arithmetic - what a drag distance means as a width - stays out of here and
 * out of the DOM entirely: it is just `startWidth + (clientX - startX)`,
 * clamped by `setWidth` itself (`useRosterWidth.ts`), so there is nothing
 * left for this hook to compute beyond tracking where the drag began. Split
 * from the handle component the way `useSheetDismissGestures.ts` is split
 * from `sheetGesture.ts` - jsdom has no layout or pointer capture, so this
 * side is checked by hand at a real window instead.
 *
 * `width` is read through a ref (`widthRef`) so the listeners are attached
 * once and stay attached across every width change mid-drag - the same
 * reason `useSheetDismissGestures.ts` reads `onClose` through `onCloseRef`
 * rather than closing over it directly.
 */
export function useRosterDrag(
  handleRef: RefObject<HTMLElement | null>,
  width: number,
  setWidth: (width: number) => void,
): void {
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    // Set for the duration of the drag so a fast pointer move cannot select
    // text elsewhere on the page while it crosses it.
    let previousUserSelect = "";

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = widthRef.current;
      handle.setPointerCapture(event.pointerId);
      previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      setWidth(startWidth + (event.clientX - startX));
    };

    const endDrag = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.style.userSelect = previousUserSelect;
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", endDrag);
      handle.removeEventListener("pointercancel", endDrag);
    };
  }, [handleRef, setWidth]);
}
