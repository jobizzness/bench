import { mkdir, readdir, readlink, symlink, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where `devin acp` looks for global skills: `$XDG_CONFIG_HOME/devin/skills`,
 * falling back to `~/.config/devin/skills`. One directory per skill, holding
 * a `SKILL.md` - the same layout `plugin/skills/` already ships for Claude.
 */
function defaultSkillsHome(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "devin", "skills");
}

/**
 * Give Devin specialists the same Bench skills Claude specialists get.
 *
 * Claude gets them from `--plugin-dir`, which is a path on the command line
 * and needs no install step. Devin has no equivalent flag - it discovers
 * skills in its own config tree - so the plugin's skill directories are
 * linked into that tree once at daemon startup.
 *
 * Links rather than copies so a plugin update is picked up on the next
 * daemon start with nothing to re-install, and the target being a symlink is
 * also what makes a stale link recognizable: a link that points somewhere
 * else (a moved checkout) is ours to replace, while a real directory or file
 * is the user's own skill, which is left alone and reported in `skipped`.
 */
export async function installDevinSkills(
  pluginDir: string,
  skillsHome: string = defaultSkillsHome(),
): Promise<{ installed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];

  let skillDirs: string[];
  try {
    skillDirs = (await readdir(join(pluginDir, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { installed, skipped };
  }
  await mkdir(skillsHome, { recursive: true });

  for (const name of skillDirs) {
    try {
      const target = join(pluginDir, "skills", name);
      const dest = join(skillsHome, name);
      let stat = await lstat(dest).catch(() => null);
      if (stat?.isSymbolicLink()) {
        // Already pointing at this skill dir is the common case - a no-op
        // rather than a replace, so the install is idempotent.
        if ((await readlink(dest)) === target) continue;
        await unlink(dest);
        stat = null;
      }
      if (stat === null) {
        await symlink(target, dest, "dir");
        installed.push(name);
      } else {
        skipped.push(name);
      }
    } catch {
      skipped.push(name);
    }
  }
  return { installed, skipped };
}
