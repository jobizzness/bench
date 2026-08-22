import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsSchema, settingsInputSchema, NO_SETTINGS, type Settings } from "../shared/settings.js";

export { houseRules, NO_SETTINGS, type Settings } from "../shared/settings.js";

const path = (home: string) => join(home, "settings.json");

/** A missing or malformed file is "nothing set", never an error: the cockpit
 * has to open whatever is on disk. */
export async function readSettings(home: string): Promise<Settings> {
  try {
    return settingsSchema.parse(JSON.parse(await readFile(path(home), "utf8")));
  } catch {
    return NO_SETTINGS;
  }
}

export async function writeSettings(home: string, input: unknown): Promise<Settings> {
  const settings = settingsInputSchema.parse(input);
  await mkdir(home, { recursive: true });
  await writeFile(path(home), JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settings;
}
