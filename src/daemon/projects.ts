import { readdir, access } from "node:fs/promises";
import { join } from "node:path";

export interface Project {
  name: string;
  path: string;
}

/**
 * Bench knows your projects rather than making you spell out paths. One
 * level deep only: a repo is a directory under the root that contains a
 * .git, which is how /var/www is actually laid out.
 */
export async function listProjects(root: string): Promise<Project[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A missing or unreadable root is an empty list, not an error - the
    // form still works, it just has nothing to suggest.
    return [];
  }

  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const path = join(root, entry.name);
    try {
      await access(join(path, ".git"));
    } catch {
      continue;
    }
    projects.push({ name: entry.name, path });
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
