/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, entry, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";
import { ROLE_MODELS } from "../src/shared/role-models.js";

/**
 * Changing the role from where you read it.
 *
 * The role was a word on the header and a word on a row and nothing you could
 * do anything about - and it is the one fact up there that changes how the
 * agent behaves, so it had better be reachable.
 */

let ui: Cockpit;
afterEach(() => ui?.unmount());

async function openRoles(over: Parameters<typeof row>[0] = {}) {
  ui = await bootCockpit({ rows: [row({ role: "specialist", ...over })], entries: [entry()] });
  await ui.open("auth");
  await ui.click(ui.$("#stage-role"));
  await waitFor(() => ui.$<HTMLDialogElement>("#role-dialog")?.open === true);
  return ui;
}

describe("the role, from the stage header", () => {
  it("says what this agent is", async () => {
    ui = await bootCockpit({ rows: [row({ role: "reviewer" })], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#stage-role")!.textContent).toBe("reviewer");
  });

  it("opens the role picker when it is pressed", async () => {
    await openRoles();
    expect(ui.$$("#role-dialog .role-option").length).toBe(6);
  });

  it("marks the one it already is", async () => {
    await openRoles({ role: "researcher" });
    const current = ui.$("#role-dialog .role-option[data-current='true']");
    expect(current!.getAttribute("data-role")).toBe("researcher");
  });

  it("posts the new role and nothing else", async () => {
    await openRoles();
    await ui.click(ui.$("#role-dialog .role-option[data-role='reviewer']"));

    const posted = ui.sent.find((s) => s.url.includes("/role"));
    expect(posted!.body).toEqual({ role: "reviewer" });
  });

  it("closes without posting when the role picked is the one it is on", async () => {
    await openRoles({ role: "planner" });
    await ui.click(ui.$("#role-dialog .role-option[data-role='planner']"));

    expect(ui.sent.find((s) => s.url.includes("/role"))).toBeUndefined();
    expect(ui.$<HTMLDialogElement>("#role-dialog")!.open).toBe(false);
  });

  it("says which model each role would bring with it", async () => {
    // Changing the role can change what the tab runs on, and finding that out
    // afterwards is finding out from the bill.
    await openRoles({ model: ROLE_MODELS.specialist.preferred });
    const reviewer = ui.$("#role-dialog .role-option[data-role='reviewer'] .role-model");
    expect(reviewer!.textContent).not.toBe("");
  });

  it("warns that a hand-picked model will not follow the role", async () => {
    // They went to the picker and chose. The role change leaves it alone, and
    // the one line on the page that would otherwise be untrue says so.
    await openRoles({ role: "specialist", model: "claude-haiku-4-5-20251001" });
    expect(ui.$("#role-dialog-kept")).not.toBe(null);
  });

  it("says nothing about keeping a model that was never chosen by hand", async () => {
    await openRoles({ role: "specialist", model: ROLE_MODELS.specialist.preferred });
    expect(ui.$("#role-dialog-kept")).toBe(null);
  });

  it("leaves the roster rows without a control", async () => {
    // Twenty of these in a column is twenty things that look clickable in a
    // list you are scanning.
    ui = await bootCockpit({
      rows: [row({ id: "s1", label: "auth" }), row({ id: "s2", label: "billing" })],
      entries: [entry()],
    });
    await ui.open("auth");
    expect(ui.$$("#stage-role").length).toBe(1);
  });
});
