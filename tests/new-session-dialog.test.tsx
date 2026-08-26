/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

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
afterEach(() => {
  ui?.unmount();
  // Selection lives in the URL, and the URL outlives the mount: a test that
  // opens a specialist would otherwise decide what the next one starts on.
  history.pushState({}, "", "/?token=t");
});

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

describe("what it opens once the specialist exists", () => {
  it("puts the new specialist on the stage, not the one you were reading", async () => {
    await open();
    await fill("password-reset");
    await ui.click(ui.$("#f-create"));

    // The daemon answers with the id, then pushes the roster it belongs to.
    await ui.roster([
      row(),
      row({ id: "s-new", label: "password-reset", project: "/var/www/teledoctor" }),
    ]);

    const head = await waitFor(() => ui.$("#stage-label"), "the stage head");
    expect(head.textContent).toBe("password-reset");
    // And it is a place, so the tab you leave open is its own.
    expect(location.pathname).toBe("/s/s-new");
  });

  it("stays where it is when the dialog refuses to send", async () => {
    await open();
    await ui.click(ui.$("#roster-list .row"));
    await fill("   ");
    await ui.click(ui.$("#f-create"));

    expect(location.pathname).toBe("/s/s1");
    expect(ui.$("#stage-label")!.textContent).toBe("auth");
  });
});

describe("what it refuses to send", () => {
  it("takes a label a person would actually write", async () => {
    // It used to refuse this and ask for lowercase and hyphens, which is a
    // branch name wearing the word "label".
    await open();
    await fill("Password reset (v2)");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body.label).toBe("Password reset (v2)");
  });

  it("says what the branch will be called, rather than demanding you type it", async () => {
    await open();
    await ui.type(ui.$("#f-label"), "Password reset (v2)");

    expect(ui.$("#f-label-note")!.textContent).toContain("bench/password-reset-v2-");
  });

  it("refuses a label that is nothing at all", async () => {
    await open();
    await ui.type(ui.$("#f-project"), "teledoctor");
    await ui.type(ui.$("#f-label"), "   ");
    await ui.click(ui.$("#f-create"));

    expect(created()).toBeUndefined();
    expect(ui.$("#f-error")!.textContent).toContain("Give it a name");
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

describe("what kind of agent it opens", () => {
  const roleNote = () => ui.$("#f-role-note")!.textContent ?? "";

  it("opens a specialist unless you say otherwise", async () => {
    await open();
    await fill("password-reset");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body.role).toBe("specialist");
  });

  it("says what each one is for as it is picked", async () => {
    // Four words with no explanation is a field nobody can answer.
    await open();
    expect(roleNote()).toContain("spec to done");

    await ui.pick(ui.$("#f-role"), "reviewer");
    expect(roleNote()).toContain("says what is wrong with it");
  });

  it("sends the one that was picked", async () => {
    await open();
    await fill("second-opinion");
    await ui.pick(ui.$("#f-role"), "reviewer");
    await ui.click(ui.$("#f-create"));

    expect(created()!.body.role).toBe("reviewer");
  });

  it("comes back a specialist next time", async () => {
    await open();
    await ui.pick(ui.$("#f-role"), "researcher");
    await ui.click(ui.$("#f-cancel"));
    await ui.click(ui.$("#new-session"));

    expect(ui.$<HTMLSelectElement>("#f-role")!.value).toBe("specialist");
  });
});

describe("which model a specialist runs on", () => {
  it("opens the model modal rather than a dropdown", async () => {
    // There are several hundred models once OpenRouter is in the list, and
    // they differ in who bills you and how much they hold. None of that fits
    // in an <option>.
    const ui = await bootCockpit({ rows: [] });
    await ui.click(ui.$("#new-session"));
    await waitFor(() => ui.$("#f-model"), "the dialog");

    expect(ui.$("#f-model")!.tagName).toBe("BUTTON");
    expect(ui.$("#f-model")!.textContent).toBe("Opus 5");
    ui.unmount();
  });

  it("starts on Opus, and says nothing about billing for it", async () => {
    const ui = await bootCockpit({ rows: [] });
    await ui.click(ui.$("#new-session"));
    await waitFor(() => ui.$("#f-model"), "the dialog");

    expect(ui.$("#f-model-note")).toBe(null);
    ui.unmount();
  });
});
