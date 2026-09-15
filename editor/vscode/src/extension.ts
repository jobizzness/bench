import * as vscode from "vscode";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { EditFollower } from "./follow.js";
import { apiBase, eventsUrl, tokenPath } from "./endpoint.js";
import { BenchTree, type FileNode, type Node } from "./tree.js";
import { BASE_SCHEME, BaseContentProvider, openDiff } from "./diff.js";
import { insideWorkspace } from "./inside.js";
import { effectiveFolders, targetFolder } from "./binding.js";
import { attempt } from "./retry.js";
import { FollowStatus } from "./status.js";
import type { EditEvent } from "./types.js";

const TOGGLE_COMMAND = "bench.toggleFollow";
const DIFF_COMMAND = "bench.openDiff";
const REFRESH_COMMAND = "bench.refresh";
const CLEAR_TARGET_COMMAND = "bench.clearTarget";
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
 * The project the cockpit has pointed this window at, if any.
 *
 * Held in memory rather than persisted: it survives a daemon restart, which
 * is what matters, and a window reopened tomorrow should not still be
 * narrowed by a button someone pressed today.
 */
let bound: string | null = null;

/** Which folders this window currently speaks for - everything it has open,
 * or just the project it was targeted at. */
function following(): string[] {
  return effectiveFolders(bound, openFolders());
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
  if (!insideWorkspace(edit.path, following())) return;

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

  const tree = new BenchTree(currentApi, following, (waiting) => {
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
    onTarget: (project) => {
      // Sent to every editor, because the daemon cannot know which window
      // the developer was looking at. A window without that project open is
      // not the one being talked to, and says so by leaving it alone.
      const folder = targetFolder(project, openFolders());
      if (folder === null) return;
      bound = folder;
      status.setProject(folder);
      tree.refresh();
    },
  });

  context.subscriptions.push(
    view,
    tree,
    vscode.workspace.registerTextDocumentContentProvider(
      BASE_SCHEME, new BaseContentProvider(currentApi),
    ),
    vscode.commands.registerCommand(DIFF_COMMAND, (node: FileNode) => openDiff(node)),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => tree.refresh()),
    // A narrowing you cannot undo from inside the editor would be a trap:
    // the cockpit can point a window at a project, but it has no way to say
    // "go back to everything".
    vscode.commands.registerCommand(CLEAR_TARGET_COMMAND, () => {
      bound = null;
      status.setProject(null);
      tree.refresh();
    }),
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
