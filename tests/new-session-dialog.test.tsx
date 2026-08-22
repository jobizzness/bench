/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * Where a specialist lives is decided here and nowhere else, so the flag this
 * dialog sends is the only thing standing between "its own branch" and
 * "working in your checkout beside you".
 */

const PROJECTS = [
  { name: "teledoctor", path: "/var/www/teledoctor" },
  { name: "bench", path: "/var/www/bench" },
];

let ui: Cockpit;
afterEach(() => ui?.unmount());

const toggle = () => ui.$<HTMLInputElement>("#f-worktree")!;
const note = () => ui.$("#f-worktree-note")!.textContent ?? "";
const created = () => ui.sent.find((s) => s.url.endsWith("/api/sessions"));

async function open(): Promise<Cockpit> {
  ui = await bootCockpit({ rows: [row()], projects: PROJECTS });
  await ui.click(ui.$("#new-session"));
  return ui;
}

async function fill(label: string): Promise<void> {
  await ui.type(ui.$("#f-project"), "teledoctor");
  await ui.type(ui.$("#f-label"), label);
}

describe("choosing where a specialist lives", () => {
  it("offers a worktree by default", async () => {
    await open();
    expect(toggle().checked).toBe(true);
    expect(note()).toContain("Its own branch and files");
  });

  it("says what unticking it means, rather than leaving you to find out", async () => {
    await open();
    await ui.click(toggle());

    expect(note()).toContain("directly in your checkout");
    expect(note()).toContain("any other specialist there");
  });

  it("asks for an isolated specialist when the box is ticked", async () => {
    await open();
    await fill("password-reset");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body).toMatchObject({
      project: "/var/www/teledoctor", label: "password-reset", model: "opus", isolated: true,
    });
  });

  it("asks for one in the checkout itself when it is not", async () => {
    await open();
    await ui.click(toggle());
    await fill("quick-look");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body.isolated).toBe(false);
  });

  it("comes back ticked next time, whatever was chosen last", async () => {
    await open();
    await ui.click(toggle());
    expect(toggle().checked).toBe(false);

    await ui.click(ui.$("#f-cancel"));
    await ui.click(ui.$("#new-session"));
    // The safer of the two is the one you should have to ask for again.
    expect(toggle().checked).toBe(true);
  });
});

describe("what it refuses to send", () => {
  it("explains a bad label instead of letting the daemon 400", async () => {
    await open();
    await fill("Password Reset");
    await ui.click(ui.$("#f-create"));

    expect(created()).toBeUndefined();
    expect(ui.$("#f-error")!.textContent).toContain("lowercase letters");
  });

  it("marks the label invalid as it is typed", async () => {
    await open();
    await ui.type(ui.$("#f-label"), "Nope");
    expect(ui.$("#f-label")!.getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a project that is neither listed nor an absolute path", async () => {
    await open();
    await ui.type(ui.$("#f-project"), "not-a-repo");
    await ui.type(ui.$("#f-label"), "fine");
    await ui.click(ui.$("#f-create"));

    expect(created()).toBeUndefined();
    expect(ui.$("#f-error")!.textContent).toContain("absolute path");
  });

  it("takes an absolute path that is not on the list", async () => {
    await open();
    await ui.type(ui.$("#f-project"), "/srv/elsewhere");
    await ui.type(ui.$("#f-label"), "fine");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body.project).toBe("/srv/elsewhere");
  });
});
