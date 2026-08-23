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

async function open(settings?: { codingStyle: string; workflowRules: string }): Promise<void> {
  ui = await bootCockpit({ rows: [row()], settings });
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

    expect(saved()!.body).toEqual({ codingStyle: "terse", workflowRules: "verify first" });
  });

  it("keeps what was saved when it is reopened", async () => {
    await open({ codingStyle: "terse", workflowRules: "" });
    await ui.click(ui.$("#s-cancel"));
    await ui.click(ui.$("#open-settings"));

    await waitFor(() => ui.$<HTMLTextAreaElement>("#s-style")?.value === "terse" || null, "the reload");
    expect(ui.$<HTMLTextAreaElement>("#s-style")!.value).toBe("terse");
  });
});
