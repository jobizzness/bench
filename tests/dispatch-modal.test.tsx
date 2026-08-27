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

/** The specialist that opened it, which is the tab the developer is on. */
const parent = (over: Partial<Parameters<typeof row>[0]> = {}) => row({
  id: "s1", label: "auth", status: "working", detail: "thinking", ...over,
});

/** Strictly: a dialog that is not on the page at all is not an open one, and
 * `null?.getAttribute()` is undefined, which passes every loose check. */
const showing = (selector: string) => {
  const dialog = ui.$(selector);
  return dialog !== null && dialog.hasAttribute("open");
};

describe("a tab held for you to dispatch", () => {
  it("opens as soon as you select it", async () => {
    ui = await bootCockpit({ rows: [pending()] });
    await ui.open("payouts");

    expect(showing("#dispatch-modal")).toBe(true);
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

describe("where the hand-off is read", () => {
  it("opens over the thread of the specialist that made the hand-off", async () => {
    ui = await bootCockpit({ rows: [parent(), pending({ createdBy: "s1" })] });
    await ui.open("auth");

    expect(showing("#dispatch-modal")).toBe(true);
    expect(ui.$("#dispatch-prompt")?.textContent).toBe("Build what the spec at docs/x.md describes.");
  });

  it("names the tab being handed work, not the one you are reading", async () => {
    ui = await bootCockpit({ rows: [parent(), pending({ createdBy: "s1" })] });
    await ui.open("auth");

    expect(ui.$("#dispatch-modal h2")?.textContent).toBe("payouts");
  });

  it("dispatches the held tab, not the one on screen", async () => {
    ui = await bootCockpit({ rows: [parent(), pending({ createdBy: "s1" })] });
    await ui.open("auth");

    await ui.click(ui.$("#dispatch-dispatch"));

    expect(ui.sent.at(-1)).toMatchObject({ url: expect.stringContaining("/api/sessions/child/dispatch") });
  });

  it("arrives while you are already reading the parent", async () => {
    ui = await bootCockpit({ rows: [parent()] });
    await ui.open("auth");
    expect(ui.$("#dispatch-modal")).toBeNull();

    await ui.roster([parent(), pending({ createdBy: "s1" })]);

    expect(showing("#dispatch-modal")).toBe(true);
  });

  it("stays out of a thread that has nothing to do with it", async () => {
    ui = await bootCockpit({
      rows: [parent(), row({ id: "other", label: "billing" }), pending({ createdBy: "s1" })],
    });
    await ui.open("billing");

    expect(ui.$("#dispatch-modal")).toBeNull();
  });

  it("survives the roster being pushed again while it is up", async () => {
    // Every other specialist's progress re-pushes the whole roster, so this
    // happens constantly. Reopening an open dialog throws.
    ui = await bootCockpit({ rows: [parent(), pending({ createdBy: "s1" })] });
    await ui.open("auth");

    await ui.roster([parent({ detail: "writing" }), pending({ createdBy: "s1" })]);

    expect(showing("#dispatch-modal")).toBe(true);
  });
});

describe("moving a held tab off the model it inherited", () => {
  const held = { rows: [parent(), pending({ createdBy: "s1" })] };

  it("opens the picker over the hand-off", async () => {
    ui = await bootCockpit(held);
    await ui.open("auth");

    await ui.click(ui.$("#dispatch-model"));

    expect(showing("#dispatch-model-dialog")).toBe(true);
  });

  it("moves the held tab, not the one being read", async () => {
    ui = await bootCockpit({ ...held, routerKey: { present: true, hint: "…key" } });
    await ui.open("auth");
    await ui.click(ui.$("#dispatch-model"));

    await ui.click(ui.$('#dispatch-model-dialog [data-model="haiku"]'));

    expect(ui.sent.at(-1)).toMatchObject({
      url: expect.stringContaining("/api/sessions/child/model"),
      body: { model: "haiku" },
    });
  });

  it("keeps its search box out of the dispatch form", async () => {
    // Enter in a text field submits the form the field sits in, and the
    // picker used to sit inside this one - so typing "flash" and pressing
    // Enter sent the agent off on the model being replaced. Asserted on the
    // structure rather than on a key press, because jsdom does not implement
    // implicit submission and would pass either way.
    ui = await bootCockpit({ ...held, routerKey: { present: true, hint: "…key" } });
    await ui.open("auth");
    await ui.click(ui.$("#dispatch-model"));

    expect(ui.$("#dispatch-model-dialog-search")?.closest("form")).toBeNull();
  });

  it("offers the way to a key when there is none, rather than a dead list", async () => {
    ui = await bootCockpit(held);
    await ui.open("auth");
    await ui.click(ui.$("#dispatch-model"));

    await ui.click(ui.$("#dispatch-model-dialog-need-key"));

    expect(showing("#settings-dialog")).toBe(true);
  });
});
