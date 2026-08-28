import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/daemon/settings.js";
import { houseRules, NO_SETTINGS } from "../src/shared/settings.js";

const home = () => mkdtemp(join(tmpdir(), "bench-settings-"));

describe("what is on disk", () => {
  it("comes back as it was saved", async () => {
    const dir = await home();
    await writeSettings(dir, { codingStyle: "comments say why", workflowRules: "run the tests" });

    expect(await readSettings(dir)).toEqual({
      codingStyle: "comments say why",
      workflowRules: "run the tests",
      reviewModel: "opus",
      roleModels: {},
      reasoningEffort: "medium",
    });
  });

  it("reads nothing set when nothing has been saved", async () => {
    expect(await readSettings(await home())).toEqual(NO_SETTINGS);
  });

  it("reads nothing set rather than throwing on a broken file", async () => {
    // The cockpit has to open whatever is on disk. A settings page that
    // cannot render is worse than one that has forgotten your rules.
    const dir = await home();
    await writeFile(join(dir, "settings.json"), "{ not json");

    expect(await readSettings(dir)).toEqual(NO_SETTINGS);
  });

  it("fills in a field the file does not have", async () => {
    const dir = await home();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ codingStyle: "terse" }));

    expect(await readSettings(dir)).toEqual({ codingStyle: "terse", workflowRules: "", reviewModel: "opus", roleModels: {}, reasoningEffort: "medium" });
  });

  it("refuses half a set rather than erasing the half it was not sent", async () => {
    // An unparseable request body reaches the route as {}. Filling in the
    // blanks there would wipe rules nobody touched.
    const dir = await home();
    await writeSettings(dir, { codingStyle: "terse", workflowRules: "verify first" });

    await expect(writeSettings(dir, { codingStyle: "terse" })).rejects.toThrow();
    await expect(writeSettings(dir, {})).rejects.toThrow();
    expect((await readSettings(dir)).workflowRules).toBe("verify first");
  });

  it("refuses rules too long to send with every turn", async () => {
    // They ride the framing of every turn of every specialist, so length is
    // a running cost, not a one-off one.
    await expect(writeSettings(await home(), { codingStyle: "x".repeat(4001) })).rejects.toThrow();
  });

  it("writes something a person can read and edit by hand", async () => {
    const dir = await home();
    await writeSettings(dir, { codingStyle: "terse", workflowRules: "" });

    expect(await readFile(join(dir, "settings.json"), "utf8")).toContain("\n  \"codingStyle\"");
  });
});

describe("what the specialist is told", () => {
  it("says nothing at all when nothing is set", async () => {
    // Not "no rules apply" - nothing. An empty settings page must not cost a
    // line of every prompt.
    expect(houseRules(NO_SETTINGS)).toBe("");
    expect(houseRules({ codingStyle: "   ", workflowRules: "\n" })).toBe("");
  });

  it("leaves out the half you did not fill in", async () => {
    const only = houseRules({ codingStyle: "comments say why", workflowRules: "" });

    expect(only).toContain("Coding style:\ncomments say why");
    expect(only).not.toContain("Workflow:");
  });

  it("marks them as standing instructions, not the task", async () => {
    // A specialist that reads its house rules as this turn's brief will go and
    // do them.
    const both = houseRules({ codingStyle: "terse", workflowRules: "run the tests" });

    expect(both).toContain("standing");
    expect(both).toContain("not the task itself");
    expect(both.indexOf("Coding style:")).toBeLessThan(both.indexOf("Workflow:"));
  });
});

describe("which model reviews", () => {
  it("keeps the one that was chosen", async () => {
    const dir = await home();
    await writeSettings(dir, { codingStyle: "", workflowRules: "", reviewModel: "haiku" });

    expect((await readSettings(dir)).reviewModel).toBe("haiku");
  });

  it("refuses a model this bench does not offer", async () => {
    // The alias goes to the CLI unaltered. A typo saved here is a reviewer
    // that fails to start, days later, from a button with no field on it.
    await expect(
      writeSettings(await home(), { codingStyle: "", workflowRules: "", reviewModel: "gpt-4" }),
    ).rejects.toThrow();
  });

  it("takes rules from a client that has never heard of the field", async () => {
    const dir = await home();
    await writeSettings(dir, { codingStyle: "terse", workflowRules: "" });

    expect(await readSettings(dir)).toEqual({ codingStyle: "terse", workflowRules: "", reviewModel: "opus", roleModels: {}, reasoningEffort: "medium" });
  });

  it("keeps a model written into the file by hand", async () => {
    // The CLI takes full model names as well as aliases, and a file is a
    // reasonable place to put one. Reading is lenient; only saving is fussy.
    const dir = await home();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ reviewModel: "claude-fable-5" }));

    expect((await readSettings(dir)).reviewModel).toBe("claude-fable-5");
  });
});

describe("what each kind of work runs on", () => {
  it("keeps only what the developer has actually changed", async () => {
    // Not a copy of all six. A table written into the file is a table that
    // stops following the built-in one the moment a model is renamed.
    const dir = await home();
    await writeSettings(dir, {
      codingStyle: "", workflowRules: "",
      roleModels: { researcher: "haiku" },
    });

    expect((await readSettings(dir)).roleModels).toEqual({ researcher: "haiku" });
  });

  it("refuses a model this bench could not run", async () => {
    await expect(writeSettings(await home(), {
      codingStyle: "", workflowRules: "", roleModels: { researcher: "gpt-4" },
    })).rejects.toThrow();
  });

  it("reads a file written before roles had models of their own", async () => {
    const dir = await home();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ reviewModel: "haiku" }));

    expect((await readSettings(dir)).roleModels).toEqual({});
  });
});
