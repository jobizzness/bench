import { mkdir, mkdtemp, readlink, realpath, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installDevinSkills } from "../src/daemon/devin-skills.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bench-devin-skills-"));
  const pluginDir = join(root, "plugin");
  const skillsHome = join(root, "skills-home");
  for (const name of ["bench-reply", "bench-report", "bench-roster"]) {
    await mkdir(join(pluginDir, "skills", name), { recursive: true });
    await writeFile(join(pluginDir, "skills", name, "SKILL.md"), `# ${name}`);
  }
  return { pluginDir, skillsHome };
}

describe("installDevinSkills", () => {
  it("links every plugin skill into the skills home, resolving to the plugin dir", async () => {
    const { pluginDir, skillsHome } = await fixture();
    const { installed, skipped } = await installDevinSkills(pluginDir, skillsHome);

    expect(skipped).toEqual([]);
    expect(installed.sort()).toEqual(["bench-reply", "bench-report", "bench-roster"]);
    for (const name of installed) {
      expect(await readlink(join(skillsHome, name))).toBe(join(pluginDir, "skills", name));
      expect(await realpath(join(skillsHome, name, "SKILL.md"))).toBe(
        await realpath(join(pluginDir, "skills", name, "SKILL.md")),
      );
    }
  });

  it("replaces a stale symlink left behind by a moved checkout", async () => {
    const { pluginDir, skillsHome } = await fixture();
    const stale = join(await mkdtemp(join(tmpdir(), "bench-devin-stale-")), "bench-reply");
    await mkdir(skillsHome, { recursive: true });
    await symlink(stale, join(skillsHome, "bench-reply"), "dir");

    const { installed, skipped } = await installDevinSkills(pluginDir, skillsHome);

    expect(installed).toContain("bench-reply");
    expect(skipped).toEqual([]);
    expect(await readlink(join(skillsHome, "bench-reply"))).toBe(join(pluginDir, "skills", "bench-reply"));
  });

  it("leaves the user's own skill directory alone and reports it as skipped", async () => {
    const { pluginDir, skillsHome } = await fixture();
    await mkdir(join(skillsHome, "bench-report"), { recursive: true });
    await writeFile(join(skillsHome, "bench-report", "SKILL.md"), "# the user's own");

    const { installed, skipped } = await installDevinSkills(pluginDir, skillsHome);

    expect(skipped).toEqual(["bench-report"]);
    expect(installed).not.toContain("bench-report");
    // Still a real directory, not a link - never overwritten.
    expect((await lstat(join(skillsHome, "bench-report"))).isSymbolicLink()).toBe(false);
  });

  it("is a no-op on a second run", async () => {
    const { pluginDir, skillsHome } = await fixture();
    await installDevinSkills(pluginDir, skillsHome);
    expect(await installDevinSkills(pluginDir, skillsHome)).toEqual({ installed: [], skipped: [] });
  });
});
