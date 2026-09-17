/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, entry, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Picking a model, once the list stopped being four names.
 *
 * The picker used to draw all three hundred and sixty models it knew about,
 * as cards, in sixty headed blocks - so opening it to answer one question got
 * you a scrollbar with no bottom, and most of what it offered could not have
 * run a specialist even if you had picked it. These are the properties that
 * stop that coming back.
 */

function model(over: Partial<{
  id: string; name: string; vendor: string;
  contextLength: number | null; dollarsPerMillion: number | null;
}> = {}) {
  const id = over.id ?? "google/gemini-3.7-flash";
  // One knob for price in these fixtures, as there was when a row quoted one
  // number: the output price. The other three are derived from it so a row
  // still has something to draw in every column.
  const out = over.dollarsPerMillion === undefined ? 1.875 : over.dollarsPerMillion;
  return {
    id,
    name: over.name ?? "Google: Gemini 3.7 Flash",
    vendor: over.vendor ?? id.split("/")[0]!,
    contextLength: over.contextLength === undefined ? 1_048_576 : over.contextLength,
    price: out === null
      ? { fresh: null, cacheWrite: null, cacheRead: null, out: null }
      : { fresh: out / 5, cacheWrite: out / 4, cacheRead: out / 50, out },
  };
}

/** A catalogue big enough to be worth searching. */
function many(count: number) {
  return Array.from({ length: count }, (_, i) => model({
    id: `vendor${String(i).padStart(3, "0")}/model-${i}`,
    name: `Vendor${i}: Model ${i}`,
    dollarsPerMillion: i,
  }));
}

let ui: Cockpit;
afterEach(() => ui?.unmount());

/** Open the composer's picker on a specialist that exists. */
async function openPicker(fixtures: Parameters<typeof bootCockpit>[0]) {
  ui = await bootCockpit(fixtures);
  // The composer belongs to whichever specialist is selected, so there has to
  // be one before there is a model button to press.
  await ui.open("auth");
  await ui.click(ui.$("#composer-model"));
  await waitFor(() => ui.$("#model-dialog-search") !== null);
  return ui;
}

const one = { rows: [row({ model: "opus" })], entries: [entry()] };

/** The setting on - the catalogue, Anthropic and the auto-routers behave as
 * they did before this house-hiding setting existed (#141). Most of these
 * tests are about that catalogue, not about the setting itself, so they opt
 * back into it rather than assert against the new default. */
const everyHouse = { allHouses: true, codingStyle: "", workflowRules: "" };

describe("the model picker", () => {
  it("draws a bounded number of models, however many there are", async () => {
    // The property that matters is that the list has a floor. Three hundred
    // rows in a modal is not a list anybody reads; it is a wall you close.
    await openPicker({ ...one, settings: everyHouse, routerKey: { present: true, hint: "…4f2a" }, models: many(300) });
    const drawn = ui.$$("#model-dialog .model-row").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(40);
  });

  it("says how many it is not showing rather than stopping silently", async () => {
    // A list that stops at forty without saying so reads as a list of forty.
    await openPicker({ ...one, settings: everyHouse, routerKey: { present: true, hint: "…4f2a" }, models: many(300) });
    expect(ui.$("#model-dialog-more")!.textContent).toContain("300");
  });

  it("puts what was typed for at the top, not merely somewhere in the list", async () => {
    // A substring filter answers "gpt" with whatever happened to be listed
    // first. The answer to "gpt" is GPT.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [
        model({ id: "meta-llama/llama-4-gpt-compat", name: "Meta: Llama 4 GPT-compat" }),
        model({ id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" }),
      ],
    });
    await ui.type(ui.$("#model-dialog-search"), "gpt");
    expect(ui.$$("#model-dialog .model-row")[0]!.getAttribute("data-model")).toBe("openai/gpt-5.6-luna");
  });

  it("finds a model by a word in the middle of its name", async () => {
    // "flash" is how people look for Gemini Flash. Matching only the start of
    // the id would miss it.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model(), model({ id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna" })],
    });
    await ui.type(ui.$("#model-dialog-search"), "flash");
    expect(ui.$$("#model-dialog .model-row").map((r) => r.getAttribute("data-model")))
      .toEqual(["google/gemini-3.7-flash"]);
  });

  it("takes arrows and Enter, so a search never needs the mouse", async () => {
    // Type three letters, press Enter. With hundreds of models that has to be
    // the whole interaction - and the caret has to stay in the search box, or
    // the query is lost on the way to the row.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model(), model({ id: "google/gemini-3.6-flash", name: "Google: Gemini 3.6 Flash" })],
    });
    const search = ui.$<HTMLInputElement>("#model-dialog-search")!;
    // Read off the list rather than assumed: two presses lands on the second
    // row, whichever way the two happen to sort.
    const second = ui.$$("#model-dialog .model-row")[1]!.getAttribute("data-model");

    // One extra press over the two rows: Devin's account default takes the
    // first stop on the way there now (#141) - arrows walk through it too.
    await ui.pressIn(search, "ArrowDown");
    await ui.pressIn(search, "ArrowDown");
    await ui.pressIn(search, "ArrowDown");
    expect(ui.$("#model-dialog .model-row[data-active='true']")!.getAttribute("data-model"))
      .toBe(second);

    await ui.pressIn(search, "Enter");
    const posted = ui.sent.find((s) => s.url.includes("/model"));
    expect(posted!.body).toEqual({ model: second });
  });

  it("puts the caret in the search box, because searching is what it is for", async () => {
    // showModal() takes focus itself and gives it to the first focusable
    // thing in the dialog, which is Opus - so this has to be asked for, and
    // `autoFocus` alone does not survive it.
    await openPicker({ ...one, routerKey: { present: true, hint: "…4f2a" }, models: many(50) });
    expect(document.activeElement).toBe(ui.$("#model-dialog-search"));
  });

  it("shows what a model costs, because it is the developer's own money", async () => {
    // These turns are billed to their OpenRouter account rather than to a
    // subscription already paid for, and the spread across the catalogue is
    // two orders of magnitude. What the row says is the cost of a turn; the
    // three catalogue rates behind it are on the row's tooltip, which is
    // where a reference figure belongs when it is not what is being decided.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model({ dollarsPerMillion: 1.875 })],
    });

    expect(ui.$("#model-dialog .model-row .model-turn")!.textContent).toMatch(/¢|\$/);
    expect(ui.$("#model-dialog .model-row")!.getAttribute("title"))
      .toBe("Per million tokens: $0.38 fresh input, $0.04 cached, $1.88 output.");
  });

  it("says nothing about a price that is not per-token", async () => {
    // The catalogue quotes a sentinel for models priced per request. Drawing
    // one as a figure would be inventing it, and drawing it as free would be
    // worse - it would sort to the top of the cheapest-first list.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model({ id: "mystery/per-request", name: "Priced Per Request", dollarsPerMillion: null })],
    });
    expect(ui.$("#model-dialog .model-row")!.getAttribute("title"))
      .toBe("This one is not priced per token.");
    expect(ui.$("#model-dialog .model-row .model-turn")!.textContent).toBe("not quoted");
  });

  it("names the model without repeating the vendor a third time", async () => {
    // The vendor is already the heading the row sits under and already the
    // front of the id. Saying it again is what pushed rows onto two lines.
    await openPicker({
      ...one,
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model()],
    });
    expect(ui.$("#model-dialog .model-row b")!.textContent).toBe("Gemini 3.7 Flash");
  });

  it("keeps the model it is already on in the list, wherever it ranks", async () => {
    // A picker that cannot show what you would be changing from is asking you
    // to remember it.
    const current = model({ id: "vendor299/model-299", name: "Vendor299: Model 299" });
    await openPicker({
      rows: [row({ model: "vendor299/model-299" })],
      entries: [entry()],
      settings: everyHouse,
      routerKey: { present: true, hint: "…4f2a" },
      models: [...many(300), current],
    });
    expect(ui.$$("#model-dialog .model-row").map((r) => r.getAttribute("data-model")))
      .toContain("vendor299/model-299");
  });

  it("offers a way to add a key rather than only naming one", async () => {
    // The old note pointed at Settings and stopped there, which left the
    // developer inside a modal reading about something they could not go do.
    await openPicker({ ...one, settings: everyHouse, models: [model()] });
    expect(ui.$("#model-dialog-need-key")).not.toBe(null);

    await ui.click(ui.$("#model-dialog-need-key"));
    await waitFor(() => ui.$<HTMLDialogElement>("#settings-dialog")?.open === true);
    expect(ui.$<HTMLDialogElement>("#model-dialog")!.open).toBe(false);
  });

  it("does not offer to add a key that is already there", async () => {
    await openPicker({ ...one, settings: everyHouse, routerKey: { present: true, hint: "…4f2a" }, models: [model()] });
    expect(ui.$("#model-dialog-need-key")).toBe(null);
  });

  it("will not let a model be picked while there is no key to reach it", async () => {
    await openPicker({ ...one, settings: everyHouse, models: [model()] });
    expect(ui.$<HTMLButtonElement>("#model-dialog .model-row")!.disabled).toBe(true);
  });

  it("still opens on Anthropic's four when OpenRouter will not answer", async () => {
    // Those go straight to Anthropic on the machine's own login, so a picker
    // that refused to open would be refusing over something that does not
    // affect them.
    await openPicker({ ...one, settings: everyHouse, models: "unreachable" });
    expect(ui.$$("#model-dialog [data-house='anthropic'] .model-option").length).toBe(4);
    expect(ui.$("#model-dialog-error")!.textContent).toContain("Anthropic's models still work");
  });

  it("shows Devin under its own heading, not folded under a vendor", async () => {
    // Devin has no vendor prefix and is not in the OpenRouter catalogue.
    // It must appear in a dedicated section, not inside the catalogue list.
    await openPicker({ ...one, models: [] });
    const section = ui.$("#model-dialog [data-house='devin']");
    expect(section).not.toBe(null);
    const button = section!.querySelector("[data-model='devin']");
    expect(button).not.toBe(null);
    // Devin needs no OpenRouter key — it must be enabled regardless of key state.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("can pick Devin's account default without an OpenRouter key", async () => {
    // Devin is a local runtime. Picking it must not require any key.
    await openPicker({ ...one, models: [] });
    await ui.click(ui.$("#model-dialog [data-model='devin']"));
    const posted = ui.sent.find((s) => s.url.includes("/model"));
    expect(posted!.body).toEqual({ model: "devin" });
  });

  it("offers Devin's own families, from the machine rather than a hardcoded list (#114)", async () => {
    await openPicker({
      ...one,
      models: [],
      devinFamilies: [{ id: "adaptive", label: "Adaptive" }, { id: "opus", label: "Opus" }],
    });
    const section = ui.$("#model-dialog [data-house='devin']")!;
    expect(section.querySelector("[data-model='devin:adaptive']")).not.toBe(null);
    expect(section.querySelector("[data-model='devin:opus']")).not.toBe(null);
    // Still offered alongside the families, not replaced by them.
    expect(section.querySelector("[data-model='devin']")).not.toBe(null);
  });

  it("marks the family a specialist is already on as current", async () => {
    await openPicker({
      rows: [row({ model: "devin:adaptive" })],
      entries: [entry()],
      models: [],
      devinFamilies: [{ id: "adaptive", label: "Adaptive" }, { id: "opus", label: "Opus" }],
    });
    const current = ui.$("#model-dialog [data-model='devin:adaptive']")!;
    expect(current.getAttribute("data-current")).toBe("true");
    expect(ui.$("#model-dialog [data-model='devin:opus']")!.getAttribute("data-current")).toBe("false");
    expect(ui.$("#model-dialog [data-model='devin']")!.getAttribute("data-current")).toBe("false");
  });

  it("can pick a Devin family, needing no OpenRouter key either", async () => {
    await openPicker({
      ...one,
      models: [],
      devinFamilies: [{ id: "adaptive", label: "Adaptive" }],
    });
    await ui.click(ui.$("#model-dialog [data-model='devin:adaptive']"));
    const posted = ui.sent.find((s) => s.url.includes("/model"));
    expect(posted!.body).toEqual({ model: "devin:adaptive" });
  });

  it("says the account default still works when Devin's own list could not be read", async () => {
    // devin models list has been observed refusing intermittently (#114) -
    // the picker still has to open, on the one thing that needs nothing
    // from that list.
    await openPicker({ ...one, models: [] });
    const note = ui.$("#model-dialog [data-house-note='devin']")!;
    expect(note.textContent).toContain("account default still works");
  });
});

/**
 * Devin first, every other house behind a setting, tap-outside to close
 * (#141).
 */
describe("closing the picker from the backdrop", () => {
  it("closes on the backdrop but not on a click inside the dialog", async () => {
    await openPicker({ ...one, models: [] });
    const dialog = ui.$<HTMLDialogElement>("#model-dialog")!;

    await ui.click(ui.$("#model-dialog h2"));
    expect(dialog.open).toBe(true);

    await ui.click(dialog);
    expect(dialog.open).toBe(false);
  });
});

describe("every other house, behind a setting", () => {
  it("shows only Devin and thinking effort with the setting off", async () => {
    await openPicker({ ...one, routerKey: { present: true, hint: "…4f2a" }, models: [model()] });

    expect(ui.$("#model-dialog [data-house='devin']")).not.toBe(null);
    expect(ui.$("#model-dialog [data-house='thinking-effort']")).not.toBe(null);
    expect(ui.$("#model-dialog [data-house='anthropic']")).toBe(null);
    expect(ui.$("#model-dialog [data-house='auto']")).toBe(null);
    expect(ui.$("#model-dialog-router")).toBe(null);
    expect(ui.$("#model-dialog-need-key")).toBe(null);
    expect(ui.$("#model-dialog-cheapest")).toBe(null);
  });

  it("restores every house once the setting is turned on", async () => {
    await openPicker({ ...one, settings: everyHouse, routerKey: { present: true, hint: "…4f2a" }, models: [model()] });

    expect(ui.$("#model-dialog [data-house='anthropic']")).not.toBe(null);
    expect(ui.$("#model-dialog [data-house='thinking-effort']")).not.toBe(null);
    expect(ui.$("#model-dialog-router")).not.toBe(null);
    expect(ui.$("#model-dialog-cheapest")).not.toBe(null);
  });

  it("keeps a current Anthropic model visible and selectable when the setting is off", async () => {
    // Whatever the setting says, the model a specialist is already on must
    // not become unswitchable because its house is hidden.
    await openPicker({ rows: [row({ model: "opus" })], entries: [entry()], models: [] });

    expect(ui.$("#model-dialog [data-house='anthropic']")).toBe(null);
    const button = ui.$<HTMLButtonElement>("#model-dialog [data-house='current'] [data-model='opus']");
    expect(button).not.toBe(null);
    expect(button!.disabled).toBe(false);
  });

  it("keeps a current OpenRouter model visible and selectable when the setting is off", async () => {
    const current = model({ id: "vendor299/model-299", name: "Vendor299: Model 299" });
    await openPicker({
      rows: [row({ model: "vendor299/model-299" })],
      entries: [entry()],
      models: [current],
    });

    expect(ui.$("#model-dialog-router")).toBe(null);
    const button = ui.$<HTMLButtonElement>("#model-dialog [data-house='current'] [data-model='vendor299/model-299']");
    expect(button).not.toBe(null);
    expect(button!.disabled).toBe(false);
  });

  it("says nothing extra about the current model once its own house is shown", async () => {
    await openPicker({ rows: [row({ model: "opus" })], entries: [entry()], settings: everyHouse, models: [] });
    expect(ui.$("#model-dialog [data-house='current']")).toBe(null);
  });

  it("reaches a Devin family with only the keyboard - arrows walk into Devin's own rows too", async () => {
    await openPicker({
      ...one,
      models: [],
      devinFamilies: [{ id: "adaptive", label: "Adaptive" }],
    });
    const search = ui.$<HTMLInputElement>("#model-dialog-search")!;

    // Nav slot zero is the account default; one more press reaches the family.
    await ui.pressIn(search, "ArrowDown");
    await ui.pressIn(search, "ArrowDown");
    await ui.pressIn(search, "Enter");

    const posted = ui.sent.find((s) => s.url.includes("/model"));
    expect(posted!.body).toEqual({ model: "devin:adaptive" });
  });
});
