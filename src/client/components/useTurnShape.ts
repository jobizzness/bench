import { useEffect, useState } from "react";
import { authFetch } from "../api.js";
import { ASSUMED_SHAPE, type TurnShape } from "../../shared/cost.js";

/**
 * The turn every model in the picker is priced against.
 *
 * The developer's own last twenty, averaged by the daemon. A model priced
 * against a thousand-token chat is priced against nothing anybody does here:
 * a specialist re-sends a long conversation on every tool call, and that is
 * the shape that decides which model is actually cheap.
 *
 * `turns` is zero until this bench has run any, and the shape is then a
 * stated assumption rather than a measurement. It goes out with the shape so
 * the page can say which of the two it is holding - an assumption a developer
 * can see is a caveat, and one they cannot is a lie.
 */
export function useTurnShape(open: boolean): { shape: TurnShape; turns: number } {
  const [state, setState] = useState<{ shape: TurnShape; turns: number }>(
    { shape: ASSUMED_SHAPE, turns: 0 },
  );

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const res = await authFetch("/api/turn-shape");
      if (!live || !res.ok) return;
      const body = await res.json() as { shape: TurnShape | null; turns: number };
      // A daemon that has recorded nothing answers with nothing, which is not
      // an error - it is a bench on its first afternoon.
      setState({ shape: body.shape ?? ASSUMED_SHAPE, turns: body.shape ? body.turns : 0 });
    })();
    return () => { live = false; };
  }, [open]);

  return state;
}
