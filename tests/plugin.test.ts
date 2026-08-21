import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), "plugin");

describe("bench plugin", () => {
  it("has a valid manifest with a name and version", async () => {
    const manifest = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("bench");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships a bench-report skill with name and description frontmatter", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name:\s*bench-report$/m);
    expect(skill).toMatch(/^description:\s*\S/m);
  });

  it("documents both required output files", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill).toContain("report.html");
    expect(skill).toContain("decision.json");
  });

  it("requires the verified / not verified split", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill).toMatch(/not verified/i);
  });
});

describe("bench-reply skill", () => {
  it("ships with name and description frontmatter", async () => {
    const skill = await readFile(join(root, "skills", "bench-reply", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name:\s*bench-reply$/m);
    expect(skill).toMatch(/^description:\s*\S/m);
  });

  it("names the artifact it must write", async () => {
    const skill = await readFile(join(root, "skills", "bench-reply", "SKILL.md"), "utf8");
    expect(skill).toContain("reply.html");
  });

  it("warns against ending a sans stack with monospace", async () => {
    const skill = await readFile(join(root, "skills", "bench-reply", "SKILL.md"), "utf8");
    expect(skill).toMatch(/never end a sans-serif font stack with `monospace`/i);
  });

  it("keeps decision controls out of replies", async () => {
    const skill = await readFile(join(root, "skills", "bench-reply", "SKILL.md"), "utf8");
    expect(skill).toMatch(/no decision controls/i);
  });
});
