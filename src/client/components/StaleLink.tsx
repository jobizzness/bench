import { useEffect, useState } from "react";
import { STALE_EVENT } from "../api.js";

/**
 * The daemon mints a new token when it restarts, which quietly invalidates
 * every bookmark. Without this the cockpit just showed an empty roster, and
 * an empty roster looks exactly like having lost every specialist.
 */
export function StaleLink() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onStale = () => setStale(true);
    document.addEventListener(STALE_EVENT, onStale);
    return () => document.removeEventListener(STALE_EVENT, onStale);
  }, []);

  if (!stale) return null;

  return (
    <div id="stale" role="alert">
      <strong>This link is out of date.</strong>
      <span>
        Bench was restarted with a different token. Open the URL it printed, or
        reload after restarting it.
      </span>
    </div>
  );
}
