/**
 * Stopping the daemon from the terminal it is running in.
 *
 * Ctrl-C is what everybody already presses, and it is what this exists to
 * make work rather than to replace. The catch is that reading keys at all
 * means raw mode, and raw mode means the terminal stops turning Ctrl-C into
 * a signal and hands it over as a byte instead - so anything that listens
 * for one key has to listen for both, or it breaks the gesture it was added
 * beside.
 */

/** Ctrl-C, as it arrives once the terminal has stopped interpreting it. */
const INTERRUPT = "\u0003";

export function isStopKey(key: string): boolean {
  return key === "q" || key === "Q" || key === INTERRUPT;
}

/**
 * Nothing is installed unless somebody is actually sitting there. Run under
 * a process manager, or with its output going to a file, the daemon's stdin
 * is not a terminal and raw mode would throw.
 *
 * Returns how to put the terminal back. A process that exits from raw mode
 * leaves the shell behind it with no echo, which looks exactly like a broken
 * terminal to the person now typing into it.
 */
export function onStopKey(stop: () => void, stdin = process.stdin): () => void {
  if (!stdin.isTTY) return () => {};

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const onKey = (key: string) => { if (isStopKey(key)) stop(); };
  stdin.on("data", onKey);

  return () => {
    stdin.off("data", onKey);
    stdin.setRawMode(false);
    // The daemon is not waiting on anybody's typing, and an open stdin would
    // hold the event loop up on its way out.
    stdin.pause();
  };
}
