import { useEffect, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { eventsUrl, linkIsStale } from "../api.js";
import { shouldReconnect } from "../reconnect.js";

export interface Roster {
  rows: RosterRow[];
  /** Whether the socket is up. `null` until the first one has settled either
   * way, so a page that is still connecting says nothing rather than
   * announcing a problem it does not have yet. */
  live: boolean | null;
}

/**
 * The roster, pushed over a socket the daemon owns. The daemon outlives the
 * page, so a dropped connection is reconnected - but a refused one is not,
 * because the token will not become valid by asking again.
 *
 * Whether the socket is up is part of what this hook knows, and it is not a
 * detail: installed on a phone, the cockpit is opened away from the daemon
 * all the time, and a roster of nobody looks exactly like having lost
 * everybody.
 */
export function useRoster(): Roster {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const where = eventsUrl();
      // Nowhere to connect to: the page has not been told where its daemon
      // is, and the setup dialog is what is in front of the developer.
      if (where === null) return;
      socket = new WebSocket(where);

      socket.onopen = () => { if (!disposed) setLive(true); };

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "roster") setRows(message.rows as RosterRow[]);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        // A refused socket is a stale link, which has its own banner. Saying
        // "not connected" underneath it would be describing the same silence
        // twice, and only one of the two can be acted on.
        if (!shouldReconnect(event.code)) { linkIsStale(); return; }
        setLive(false);
        timer = setTimeout(connect, 1000);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { rows, live };
}
