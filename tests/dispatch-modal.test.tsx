/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const pending = (over: Partial<Parameters<typeof row>[0]> = {}) => row({
  id: "child", label: "payouts", status: "awaiting_dispatch",
  model: "opus", pendingPrompt: "Build what the spec at docs/x.md describes.",
  ...over,
});

describe("a tab held for you to dispatch", () => {
  it("opens as soon as you select it", async () => {
    ui = await bootCockpit({ rows: [pending()] });
    await ui.open("payouts");

    expect(ui.$("#dispatch-modal")?.getAttribute("open")).not.toBeNull();
    expect(ui.$("#dispatch-prompt")?.textContent).toBe("Build what the spec at docs/x.md describes.");
  });

  it("says nothing about a tab that is not held", async () => {
    ui = await bootCockpit({ rows: [row({ label: "auth", status: "awaiting_decision" })] });
    await ui.open("auth");

    expect(ui.$("#dispatch-modal")).toBeNull();
  });

  it("shows what it would run on, changeable through the usual model picker", async () => {
    ui = await bootCockpit({ rows: [pending({ model: "haiku" })] });
    await ui.open("payouts");

    expect(ui.$("#dispatch-model")?.textContent).toContain("Haiku");
  });

  it("dispatches on request", async () => {
    ui = await bootCockpit({ rows: [pending()] });
    await ui.open("payouts");

    await ui.click(ui.$("#dispatch-dispatch"));

    expect(ui.sent.at(-1)).toMatchObject({ url: expect.stringContaining("/api/sessions/child/dispatch") });
  });

  it("declines on request", async () => {
    ui = await bootCockpit({ rows: [pending()] });
    await ui.open("payouts");

    await ui.click(ui.$("#dispatch-decline"));

    expect(ui.sent.at(-1)).toMatchObject({ url: expect.stringContaining("/api/sessions/child/decline") });
  });
});
