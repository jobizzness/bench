import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects } from "../src/daemon/projects.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bench-projects-"));
}

async function makeRepo(root: string, name: string): Promise<void> {
  await mkdir(join(root, name, ".git"), { recursive: true });
}

describe("listProjects", () => {
  it("finds directories that contain a .git", async () => {
    const root = await makeRoot();
    await makeRepo(root, "teledoctor");

    const projects = await listProjects(root);
    expect(projects).toEqual([{ name: "teledoctor", path: join(root, "teledoctor") }]);
  });

  it("skips directories that are not git repos", async () => {
    const root = await makeRoot();
    await makeRepo(root, "sellox");
    await mkdir(join(root, "just-a-folder"), { recursive: true });

    const projects = await listProjects(root);
    expect(projects.map((p) => p.name)).toEqual(["sellox"]);
  });

  it("skips files at the root", async () => {
    const root = await makeRoot();
    await makeRepo(root, "arca");
    await writeFile(join(root, "notes.txt"), "hello");

    const projects = await listProjects(root);
    expect(projects.map((p) => p.name)).toEqual(["arca"]);
  });

  it("sorts by name", async () => {
    const root = await makeRoot();
    for (const name of ["zeta", "alpha", "middle"]) await makeRepo(root, name);

    const projects = await listProjects(root);
    expect(projects.map((p) => p.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("returns an empty list when the root does not exist", async () => {
    expect(await listProjects("/nonexistent/bench/root")).toEqual([]);
  });

  it("ignores dotfile directories", async () => {
    const root = await makeRoot();
    await makeRepo(root, "visible");
    await makeRepo(root, ".hidden");

    const projects = await listProjects(root);
    expect(projects.map((p) => p.name)).toEqual(["visible"]);
  });

  it("returns absolute POSIX paths", async () => {
    const root = await makeRoot();
    await makeRepo(root, "repo");

    const [project] = await listProjects(root);
    expect(project.path.startsWith("/")).toBe(true);
    expect(project.path).not.toContain("\\");
  });
});
