import { useEffect, useState } from "react";
import { authFetch, token } from "../api.js";
import { isHere, targetUrl, toOrigin } from "../server-location.js";

interface Known { origins: string[]; loopbackOnly: boolean }

/**
 * Where this cockpit is pointed, and how to point it somewhere else.
 *
 * Switching is a navigation rather than a setting: everything the client
 * fetches is relative to whatever served it, so going to the address is the
 * only way for the roster, the thread and the socket to all agree about which
 * daemon they are talking to.
 */
export function ServerLocation({ open }: { open: boolean }) {
  const [known, setKnown] = useState<Known>({ origins: [], loopbackOnly: true });
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const res = await authFetch("/api/addresses");
      if (!live || !res.ok) return;
      setKnown(await res.json());
    })();
    return () => { live = false; };
  }, [open]);

  // Links rather than buttons, because that is what they are: another address
  // for this page. The navigation is the refresh, and it comes free - along
  // with opening one in a new tab to have both in front of you.
  const go = (origin: string) => targetUrl(origin, token, location.pathname);

  const typedOrigin = toOrigin(typed);
  const elsewhere = known.origins.filter((origin) => !isHere(origin));

  return (
    <section id="s-server">
      <label htmlFor="s-address">Server</label>

      <p className="field-note" id="s-here">
        This tab is talking to <code>{location.origin}</code>. Changing it loads
        the cockpit from the new address — same token, same page.
      </p>

      {elsewhere.length > 0 && (
        <div id="s-known">
          {elsewhere.map((origin) => (
            <a className="s-address" key={origin} href={go(origin)}>
              <span className="s-address-url">{origin}</span>
              {origin.includes("127.0.0.1") && (
                <span className="s-address-note">only from this machine</span>
              )}
            </a>
          ))}
        </div>
      )}

      {known.loopbackOnly && (
        <p className="field-note">
          This daemon is bound to loopback, so it answers at one address only.
          Start it with <code>BENCH_LAN=1</code> to reach it from another device.
        </p>
      )}

      <div id="s-address-row">
        <input
          id="s-address"
          autoComplete="off"
          placeholder="192.168.1.198:7420"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          // This sits inside the house rules form, where a stray Enter would
          // otherwise save them.
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        />
        <a
          id="s-address-go"
          // No href is the disabled state, and the only one a link has.
          href={typedOrigin && !isHere(typedOrigin) ? go(typedOrigin) : undefined}
          aria-disabled={typedOrigin === "" || isHere(typedOrigin)}
        >
          Go
        </a>
      </div>
      <p className="field-note">
        Another machine's daemon has its own token, so that one needs the whole
        link rather than an address.
      </p>
    </section>
  );
}
