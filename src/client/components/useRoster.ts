import { useEffect, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { linkIsStale, token } from "../api.js";
import { shouldReconnect } from "../reconnect.js";

/**
 * The roster, pushed over a socket the daemon owns. The daemon outlives the
 * page, so a dropped connection is reconnected - but a refused one is not,
 * because the token will not become valid by asking again.
 */
export function useRoster(): RosterRow[] {
  const [rows, setRows] = useState<RosterRow[]>([]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      socket = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "roster") setRows(message.rows as RosterRow[]);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        if (!shouldReconnect(event.code)) { linkIsStale(); return; }
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

  return rows;
}
