/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * What has been happening on the project, without leaving the cockpit for a
 * browser tab and coming back having forgotten what you went for.
 */

const ITEMS = [
  {
    number: 15, title: "The questionnaire gets a sheet of its own",
    url: "https://github.com/o/r/pull/15", kind: "pull",
    state: "merged", updatedAt: new Date().toISOString(), author: "jobizzness",
  },
  {
    number: 8, title: "Composer: hover affordance, Shift+Enter expansion, and image attachments",
    url: "https://github.com/o/r/issues/8", kind: "issue",
    state: "open", updatedAt: new Date().toISOString(), author: "jobizzness",
  },
];

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const drawer = () => ui.$<HTMLDialogElement>("#gh-drawer");
const rows = () => ui.$$(".gh-row");

async function open(github: { slug: string | null; items: unknown[] }): Promise<void> {
  ui = await bootCockpit({ rows: [row()], entries: [entry()], github });
  await ui.open("auth");
  await ui.click(ui.$("#open-github"));
  await waitFor(() => drawer()?.hasAttribute("open") || null, "the drawer");
}

describe("the GitHub drawer", () => {
  it("is not there at all until a specialist is on the stage", async () => {
    // It lives in that specialist's header, so with nothing open there is no
    // button to disable and no project it could be about.
    ui = await bootCockpit({ rows: [row()] });
    expect(ui.$("#open-github")).toBeNull();

    await ui.open("auth");
    expect(ui.$("#open-github")).not.toBeNull();
  });

  it("lists what has moved lately, pull requests first", async () => {
    await open({ slug: "o/r", items: ITEMS });

    expect(ui.$("#gh-slug")!.textContent).toBe("o/r");
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain("The questionnaire gets a sheet of its own");
    expect(rows()[0].getAttribute("data-kind")).toBe("pull");
  });

  it("links each line to the thing itself", async () => {
    await open({ slug: "o/r", items: ITEMS });
    const link = rows()[1] as HTMLAnchorElement;

    expect(link.href).toBe("https://github.com/o/r/issues/8");
    expect(link.target).toBe("_blank");
  });

  it("says why it is empty when the project is not on GitHub", async () => {
    // A blank drawer reads as broken. This one says what is actually true.
    await open({ slug: null, items: [] });
    expect(ui.$(".gh-note")!.textContent).toContain("no GitHub remote");
  });

  it("says the repository is quiet rather than blaming itself", async () => {
    await open({ slug: "o/r", items: [] });
    expect(ui.$(".gh-note")!.textContent).toContain("Nothing open or recently touched");
  });

  it("asks GitHub only when it is opened", async () => {
    ui = await bootCockpit({ rows: [row()], entries: [entry()], github: { slug: "o/r", items: ITEMS } });
    await ui.open("auth");
    expect(ui.fetched.some((url) => url.includes("/github"))).toBe(false);

    await ui.click(ui.$("#open-github"));
    await waitFor(() => drawer()?.hasAttribute("open") || null, "the drawer");
    expect(ui.fetched.some((url) => url.includes("/github"))).toBe(true);
  });

  it("closes again", async () => {
    await open({ slug: "o/r", items: ITEMS });
    await ui.click(ui.$("#gh-close"));
    expect(drawer()!.hasAttribute("open")).toBe(false);
  });

  it("closes when the scrim is clicked", async () => {
    // The backdrop belongs to the dialog, so a click on it arrives with the
    // dialog as its target. Anything inside reports itself instead.
    await open({ slug: "o/r", items: ITEMS });
    await ui.click(drawer());

    expect(drawer()!.hasAttribute("open")).toBe(false);
  });

  it("stays open when something inside it is clicked", async () => {
    await open({ slug: "o/r", items: ITEMS });
    await ui.click(ui.$("#gh-slug"));

    expect(drawer()!.hasAttribute("open")).toBe(true);
  });
});
