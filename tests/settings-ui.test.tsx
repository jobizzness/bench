/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * House rules are instructions to a model, so the only honest way to show
 * what they will do is to show the words the specialist receives. The preview
 * is composed by the same function the daemon uses, and these tests are what
 * stops the two drifting apart.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const saved = () => ui.sent.find((s) => s.url.endsWith("/api/settings"));
const framing = () => ui.$("#s-framing")!.textContent ?? "";

import { Settings } from "../src/shared/settings.js";

async function open(settings?: Partial<Settings>): Promise<void> {
  ui = await bootCockpit({ rows: [row()], settings: { codingStyle: "", workflowRules: "", ...settings } });
  await ui.click(ui.$("#open-settings"));
  await waitFor(() => ui.$("#s-style"), "the rules page");
}

describe("the house rules page", () => {
  it("opens on what is already saved, not on an empty box", async () => {
    // An empty box that then saves is how a developer loses the rules they
    // wrote last week.
    await open({ codingStyle: "comments say why", workflowRules: "run the tests" });

    expect(ui.$<HTMLTextAreaElement>("#s-style")!.value).toBe("comments say why");
    expect(ui.$<HTMLTextAreaElement>("#s-workflow")!.value).toBe("run the tests");
  });

  it("shows what a specialist is told, in the specialist's words", async () => {
    await open({ codingStyle: "comments say why", workflowRules: "" });

    expect(framing()).toContain("Coding style:\ncomments say why");
    expect(framing()).not.toContain("Workflow:");
  });

  it("updates that preview as you type, before anything is saved", async () => {
    await open();
    await ui.type(ui.$("#s-workflow"), "never touch a migration");

    expect(framing()).toContain("never touch a migration");
    expect(saved()).toBeUndefined();
  });

  it("says plainly that empty rules send nothing at all", async () => {
    await open();
    expect(framing()).toContain("Nothing.");
  });

  it("saves both fields", async () => {
    await open();
    await ui.type(ui.$("#s-style"), "terse");
    await ui.type(ui.$("#s-workflow"), "verify first");
    await ui.click(ui.$("#s-save"));

    expect(saved()!.body).toEqual({
      codingStyle: "terse", workflowRules: "verify first", reviewModel: "opus", roleModels: {},
    });
  });

  it("keeps what was saved when it is reopened", async () => {
    await open({ codingStyle: "terse", workflowRules: "" });
    await ui.click(ui.$("#s-cancel"));
    await ui.click(ui.$("#open-settings"));

    await waitFor(() => ui.$<HTMLTextAreaElement>("#s-style")?.value === "terse" || null, "the reload");
    expect(ui.$<HTMLTextAreaElement>("#s-style")!.value).toBe("terse");
  });
});

/**
 * Every other session is opened by a person looking at a dialog. The reviewer
 * is opened by a button on a report, so its model is chosen here or nowhere.
 */
describe("what each kind of work runs on", () => {
  const shown = (role: string) =>
    ui.$(`.s-role[data-role="${role}"] .s-role-model`)!.textContent;

  it("opens every role on the model that kind of work should use", async () => {
    // A researcher reading docs and a planner deciding what to build were
    // both opened on Opus, because Opus was the only default there was.
    await open();

    expect(shown("planner")).toBe("Opus 5");
    expect(shown("researcher")).toBe("deepseek-v4-flash");
    expect(shown("reviewer")).toBe("gpt-5.1-codex-mini");
    expect(shown("implementer")).toBe("gpt-5.1-codex");
    expect(shown("assessor")).toBe("gemini-3.1-pro-preview");
  });

  it("shows the developer's own answer where they have given one", async () => {
    await open({ roleModels: { researcher: "haiku" } });

    expect(shown("researcher")).toBe("Haiku 4.5");
  });

  it("marks the ones that have been changed, so the odd one out is a glance", async () => {
    await open({ roleModels: { researcher: "haiku" } });

    expect(ui.$('.s-role[data-role="researcher"] .s-role-model')!.dataset.chosen).toBe("true");
    expect(ui.$('.s-role[data-role="planner"] .s-role-model')!.dataset.chosen).toBe("false");
  });

  it("saves only what was changed, not a copy of the whole table", async () => {
    // A table copied into the file is a table that stops following the
    // built-in one the first time a model is renamed.
    await open({ roleModels: { researcher: "haiku" } });
    await ui.click(ui.$("#s-save"));

    expect(saved()!.body.roleModels).toEqual({ researcher: "haiku" });
  });

  it("puts a role back to the built-in when it is reset", async () => {
    await open({ roleModels: { researcher: "haiku" } });

    await ui.click(ui.$('.s-role[data-role="researcher"] .s-role-reset'));

    expect(shown("researcher")).toBe("deepseek-v4-flash");
  });

  it("offers no reset on a role nobody has touched", async () => {
    await open();

    expect(ui.$('.s-role[data-role="planner"] .s-role-reset')).toBeNull();
  });
});
