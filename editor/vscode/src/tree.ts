import * as vscode from "vscode";
import { join } from "node:path";
import { fetchChanges } from "./changes.js";
import { isWaiting, specialistsHere, waitingCount } from "./roster.js";
import type { ChangedFile, RosterRow } from "./types.js";

export interface SpecialistNode {
  kind: "specialist";
  row: RosterRow;
}

export interface FileNode {
  kind: "file";
  sessionId: string;
  root: string;
  file: ChangedFile;
}

export type Node = SpecialistNode | FileNode;

/** git's letters, in words, for the row's description. */
const STATUS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

/**
 * The Bench view: every specialist on this window's projects, and what each
 * has changed since its branch started.
 *
 * Children are fetched per specialist rather than up front - a bench of six
 * would otherwise mean six `git status` runs on every roster push, and the
 * roster pushes on every tool call.
 */
export class BenchTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private rows: RosterRow[] = [];

  constructor(
    private readonly api: () => { base: string; token: string } | null,
    private readonly folders: () => string[],
    /** Told the waiting count whenever it moves, so the badge can follow. */
    private readonly onWaiting: (count: number) => void,
  ) {}

  /** A roster push. Cheap - it redraws the specialist rows and nothing else
   * until a node is expanded. */
  setRoster(rows: RosterRow[]): void {
    this.rows = rows;
    this.onWaiting(waitingCount(rows, this.folders()));
    this.changed.fire(undefined);
  }

  /** A specialist wrote a file, so whatever it has open may be stale. */
  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === "specialist" ? specialistItem(node) : fileItem(node);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      return specialistsHere(this.rows, this.folders())
        .map((row) => ({ kind: "specialist", row }) as const);
    }
    if (node.kind === "file") return [];

    const api = this.api();
    if (api === null) return [];

    const { files, root } = await fetchChanges(api.base, api.token, node.row.id);
    if (root === undefined) return [];
    return files.map((file) => ({ kind: "file", sessionId: node.row.id, root, file }) as const);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function specialistItem(node: SpecialistNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.row.label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = node.row.id;
  item.description = node.row.status.replace(/_/g, " ");
  item.contextValue = "benchSpecialist";
  // The one thing worth a colour here: a specialist that cannot go on until
  // the developer answers it.
  item.iconPath = new vscode.ThemeIcon(
    isWaiting(node.row) ? "question" : "person",
    isWaiting(node.row) ? new vscode.ThemeColor("charts.yellow") : undefined,
  );
  return item;
}

function fileItem(node: FileNode): vscode.TreeItem {
  const full = join(node.root, node.file.path);
  const item = new vscode.TreeItem(vscode.Uri.file(full), vscode.TreeItemCollapsibleState.None);
  item.id = `${node.sessionId}:${node.file.path}`;
  // "modified" alone would not say whether it is safe to look away: work
  // still only on disk is work that could still be lost.
  item.description = node.file.committed
    ? STATUS[node.file.status] ?? node.file.status
    : `${STATUS[node.file.status] ?? node.file.status} · uncommitted`;
  item.contextValue = "benchFile";
  item.command = {
    command: "bench.openDiff",
    title: "Open changes",
    arguments: [node],
  };
  return item;
}
