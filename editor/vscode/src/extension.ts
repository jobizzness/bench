import * as vscode from "vscode";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { EditFollower } from "./follow.js";
import { apiBase, eventsUrl, tokenPath } from "./endpoint.js";
import { BenchTree, type FileNode, type Node } from "./tree.js";
import { BASE_SCHEME, BaseContentProvider, openDiff } from "./diff.js";
import { insideWorkspace } from "./inside.js";
import { attempt } from "./retry.js";
import { FollowStatus } from "./status.js";
import type { EditEvent } from "./types.js";

const TOGGLE_COMMAND = "bench.toggleFollow";
const DIFF_COMMAND = "bench.openDiff";
const REFRESH_COMMAND = "bench.refresh";
const VIEW_ID = "bench.specialists";

/** The file may be announced a moment before the agent has written it. */
const OPEN_TRIES = 3;
const OPEN_RETRY_MS = 250;

/**
 * Reads the daemon's token off disk on every connection attempt, so a Bench
 * started after this window was is picked up without a reload. Missing is a
 * state, not an error: most windows on this machine have no daemon behind
 * them, and that must not be an exception on activation.
 */
function readToken(): string | null {
  try {
    const token = readFileSync(tokenPath(process.env, homedir()), "utf8").trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

function currentUrl(): string | null {
  const token = readToken();
  return token === null ? null : eventsUrl(process.env, token);
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

/** The daemon's HTTP routes, or null when there is no token to reach them
 * with. Read per call for the same reason the socket URL is. */
function currentApi(): { base: string; token: string } | null {
  const token = readToken();
  return token === null ? null : { base: apiBase(process.env), token };
}

export function activate(context: vscode.ExtensionContext): void {
  const status = new FollowStatus(TOGGLE_COMMAND);

  // Declared before the tree because the tree's badge callback writes to it,
  // and assigned immediately after. Nothing can fire that callback in
  // between - the first roster arrives over a socket that has not started -
  // but relying on that ordering silently is how it breaks later.
  let view: vscode.TreeView<Node> | undefined;

  const tree = new BenchTree(currentApi, openFolders, (waiting) => {
    if (view === undefined) return;
    // A zero badge is a dot in the activity bar saying nothing. Undefined is
    // how VS Code is told there is nothing to say.
    view.badge = waiting === 0
      ? undefined
      : { value: waiting, tooltip: `${waiting} waiting on you` };
  });

  view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree });

  const follower = new EditFollower({
    url: currentUrl,
    open: (edit) => { void openEdit(edit); tree.refresh(); },
    onState: (state) => status.show(state),
    onRoster: (rows) => tree.setRoster(rows),
  });

  context.subscriptions.push(
    view,
    tree,
    vscode.workspace.registerTextDocumentContentProvider(
      BASE_SCHEME, new BaseContentProvider(currentApi),
    ),
    vscode.commands.registerCommand(DIFF_COMMAND, (node: FileNode) => openDiff(node)),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => tree.refresh()),
    vscode.commands.registerCommand(TOGGLE_COMMAND, () => {
      follower.following = !follower.following;
      status.setFollowing(follower.following);
    }),
    { dispose: () => follower.stop() },
    status,
  );

  // A window with no folder open has nothing to show and nothing to follow,
  // but the socket still runs: the status bar is how the developer finds out
  // the daemon is reachable at all.
  follower.start();
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}
