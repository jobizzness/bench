import * as vscode from "vscode";
import { join } from "node:path";
import { fetchBaseBlob } from "./changes.js";
import type { FileNode } from "./tree.js";

/** Our own scheme, so VS Code asks us for the left-hand side rather than
 * looking for a file that is not on disk. */
export const BASE_SCHEME = "bench-base";

/**
 * The file as it was before the specialist started, served to VS Code's diff
 * editor.
 *
 * The URI carries the session and the path: `bench-base:/<session>/<path>`.
 * Read-only by construction - a scheme with no file behind it cannot be
 * saved, which is what we want for the left-hand side.
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly api: () => { base: string; token: string } | null) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const api = this.api();
    if (api === null) return "";

    const [sessionId, ...rest] = uri.path.replace(/^\//, "").split("/");
    const path = rest.join("/");
    if (!sessionId || path === "") return "";

    return fetchBaseBlob(api.base, api.token, sessionId, path);
  }
}

/**
 * Open one file's changes, git-style: what it was on the left, what it is
 * now on the right.
 *
 * A deleted file has nothing on the right, so the diff is against an empty
 * document under the same scheme rather than a path that would fail to open.
 */
export async function openDiff(node: FileNode): Promise<void> {
  const left = vscode.Uri.parse(`${BASE_SCHEME}:/${node.sessionId}/${node.file.path}`);
  const right = node.file.status === "D"
    ? vscode.Uri.parse(`${BASE_SCHEME}:/${node.sessionId}/`)
    : vscode.Uri.file(join(node.root, node.file.path));

  const title = `${node.file.path} — since branch start`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
}
