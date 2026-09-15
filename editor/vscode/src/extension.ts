import * as vscode from "vscode";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { EditFollower } from "./follow.js";
import { eventsUrl, tokenPath } from "./endpoint.js";
import { insideWorkspace } from "./inside.js";
import { attempt } from "./retry.js";
import { FollowStatus } from "./status.js";
import type { EditEvent } from "./types.js";

const TOGGLE_COMMAND = "bench.toggleFollow";

/** The file may be announced a moment before the agent has written it. */
const OPEN_TRIES = 3;
const OPEN_RETRY_MS = 250;

/**
 * Reads the daemon's token off disk on every connection attempt, so a Bench
 * started after this window was is picked up without a reload. Missing is a
 * state, not an error: most windows on this machine have no daemon behind
 * them, and that must not be an exception on activation.
 */
function currentUrl(): string | null {
  try {
    const token = readFileSync(tokenPath(process.env, homedir()), "utf8").trim();
    return token === "" ? null : eventsUrl(process.env, token);
  } catch {
    return null;
  }
}

/** The folders this window has open, as plain paths. */
function openFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

/**
 * Shows the file a specialist just wrote, with focus.
 *
 * Focus every time is the developer's decision, taken knowingly: it is made
 * for a second monitor and is not survivable in the window you type in. The
 * toggle in the status bar is the way out, not a softer default.
 *
 * The tab is a preview tab, so consecutive edits reuse one rather than
 * leaving forty behind - the choice was about focus, not about hoarding tabs.
 */
async function openEdit(edit: EditEvent): Promise<void> {
  if (!insideWorkspace(edit.path, openFolders())) return;

  // Already looking at it. Re-showing would steal focus back from a developer
  // who had clicked somewhere else in the same file.
  if (vscode.window.activeTextEditor?.document.uri.fsPath === edit.path) return;

  await attempt(async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(edit.path));
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }, { tries: OPEN_TRIES, delayMs: OPEN_RETRY_MS });
}

export function activate(context: vscode.ExtensionContext): void {
  const status = new FollowStatus(TOGGLE_COMMAND);

  const follower = new EditFollower({
    url: currentUrl,
    open: (edit) => { void openEdit(edit); },
    onState: (state) => status.show(state),
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(TOGGLE_COMMAND, () => {
      follower.following = !follower.following;
      status.setFollowing(follower.following);
    }),
    { dispose: () => follower.stop() },
    status,
  );

  follower.start();
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}
