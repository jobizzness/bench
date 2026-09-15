import * as vscode from "vscode";
import type { FollowState } from "./follow.js";

const TEXT: Record<FollowState, string> = {
  live: "$(eye) Bench",
  connecting: "$(sync~spin) Bench",
  offline: "$(debug-disconnect) Bench",
  "no-token": "$(key) Bench",
};

const TOOLTIP: Record<FollowState, string> = {
  live: "Following edits. Files a specialist writes will open here.",
  connecting: "Connecting to the Bench daemon…",
  offline: "No Bench daemon on this machine. Retrying.",
  "no-token": "No token found. Start Bench, or set BENCH_HOME to point at it.",
};

/**
 * One status-bar item saying whether this window is actually following.
 *
 * It exists because every failure mode of this extension is silent: no
 * daemon, no token, a paused toggle and a quiet turn all look identical from
 * the editor. Without somewhere to look, "nothing opened" is unanswerable.
 */
export class FollowStatus {
  private readonly item: vscode.StatusBarItem;
  private state: FollowState = "connecting";
  private following = true;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = command;
    this.item.show();
    this.render();
  }

  show(state: FollowState): void {
    this.state = state;
    this.render();
  }

  setFollowing(following: boolean): void {
    this.following = following;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    if (!this.following) {
      this.item.text = "$(eye-closed) Bench";
      this.item.tooltip = "Paused. Still connected; files will not open.";
      return;
    }
    this.item.text = TEXT[this.state];
    this.item.tooltip = TOOLTIP[this.state];
  }
}
