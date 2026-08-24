/**
 * The daemon is not answering.
 *
 * Worth saying out loud because the alternative is silence with an empty
 * roster under it, which is what losing every specialist looks like. It says
 * where the cockpit stands - what is on screen is the last thing the daemon
 * sent - and that nobody needs to do anything but wait, because the socket
 * is already trying again.
 *
 * Installed to a home screen, this is the ordinary case rather than the
 * exceptional one: the app opens whether or not the machine it supervises is
 * awake.
 */
export function Offline({ shown, onChangeServer }: {
  shown: boolean;
  /** Offered only where the address is something the developer chose, and so
   * something they can correct. */
  onChangeServer: (() => void) | null;
}) {
  if (!shown) return null;

  return (
    <div id="offline" role="status">
      <div className="offline-said">
        <strong>Not connected to Bench.</strong>
        <span>
          The daemon is not answering — this is the last it said. Reconnecting.
        </span>
      </div>
      {onChangeServer && (
        <button type="button" id="offline-change" onClick={onChangeServer}>Change server</button>
      )}
    </div>
  );
}
