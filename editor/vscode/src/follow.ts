import WebSocket from "ws";
import type { EditEvent, RosterRow } from "./types.js";

/** What the status bar has to say about the daemon. */
export type FollowState = "connecting" | "live" | "offline" | "no-token";

export interface FollowOptions {
  /** Re-read every attempt, so a token written after VS Code started is picked
   * up without reloading the window. Null means there is no daemon to find. */
  url: () => string | null;
  open: (edit: EditEvent) => void;
  onState: (state: FollowState) => void;
  /** The roster, as the daemon pushes it. The badge and the sidebar read it
   * from here rather than opening a second socket for it. */
  onRoster?: (rows: RosterRow[]) => void;
  /** The cockpit pointing this window at a project (#129). Sent to every
   * connected editor, so it is the window's own job to decide whether it is
   * the one being talked to. */
  onTarget?: (project: string) => void;
  retryMs?: number;
}

/**
 * Holds one socket to the local daemon and calls `open` for every file a
 * specialist writes.
 *
 * Knows nothing about VS Code, which is what lets the reconnect behaviour be
 * tested against a real server instead of by restarting an editor by hand.
 */
export class EditFollower {
  /** Paused rather than disconnected: an edit missed while off is an edit
   * missed, and reconnecting to resume would drop more of them. */
  following = true;

  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly retryMs: number;

  constructor(private readonly options: FollowOptions) {
    this.retryMs = options.retryMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;

    const where = this.options.url();
    if (where === null) {
      // No token on disk. The daemon has never run here, or is running out of
      // a different BENCH_HOME - either way, keep looking rather than giving
      // up for the life of the window.
      this.options.onState("no-token");
      this.retry();
      return;
    }

    this.options.onState("connecting");
    const socket = new WebSocket(where);
    this.socket = socket;

    socket.on("open", () => this.options.onState("live"));
    socket.on("message", (raw) => this.receive(raw.toString()));
    // Without this an unreachable daemon is an unhandled 'error' event, which
    // in an extension host is a crash rather than a retry.
    socket.on("error", () => { /* handled by close */ });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.options.onState("offline");
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.retryMs);
  }

  private receive(raw: string): void {
    let frame: { type?: string };
    try {
      frame = JSON.parse(raw);
    } catch {
      // The roster is the only other thing on this socket and it is large; a
      // frame we cannot read is not worth taking the extension host down for.
      return;
    }

    if (frame.type === "target") {
      // Like the roster, not gated on `following`: pausing stops files
      // opening, it does not stop the window being told what it is for.
      const project = (frame as { project?: string }).project;
      if (typeof project === "string" && project !== "") this.options.onTarget?.(project);
      return;
    }

    if (frame.type === "roster") {
      // Not gated on `following`: pausing is about files opening, not about
      // the sidebar going blind.
      this.options.onRoster?.((frame as { rows?: RosterRow[] }).rows ?? []);
      return;
    }

    if (frame.type !== "edit" || !this.following) return;
    this.options.open(frame as EditEvent);
  }
}
