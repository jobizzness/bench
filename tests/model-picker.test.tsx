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
  return {
    id,
    name: over.name ?? "Google: Gemini 3.7 Flash",
    vendor: over.vendor ?? id.split("/")[0]!,
    contextLength: over.contextLength === undefined ? 1_048_576 : over.contextLength,
    dollarsPerMillion: over.dollarsPerMillion === undefined ? 1.875 : over.dollarsPerMillion,
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

describe("the model picker", () => {
  it("draws a bounded number of models, however many there are", async () => {
    // The property that matters is that the list has a floor. Three hundred
    // rows in a modal is not a list anybody reads; it is a wall you close.
    await openPicker({ ...one, routerKey: { present: true, hint: "…4f2a" }, models: many(300) });
    const drawn = ui.$$("#model-dialog .model-row").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(40);
  });

  it("says how many it is not showing rather than stopping silently", async () => {
    // A list that stops at forty without saying so reads as a list of forty.
    await openPicker({ ...one, routerKey: { present: true, hint: "…4f2a" }, models: many(300) });
    expect(ui.$("#model-dialog-more")!.textContent).toContain("300");
  });

  it("puts what was typed for at the top, not merely somewhere in the list", async () => {
    // A substring filter answers "gpt" with whatever happened to be listed
    // first. The answer to "gpt" is GPT.
    await openPicker({
      ...one,
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
      routerKey: { present: true, hint: "…4f2a" },
      models: [model(), model({ id: "google/gemini-3.6-flash", name: "Google: Gemini 3.6 Flash" })],
    });
    const search = ui.$<HTMLInputElement>("#model-dialog-search")!;
    // Read off the list rather than assumed: two presses lands on the second
    // row, whichever way the two happen to sort.
    const second = ui.$$("#model-dialog .model-row")[1]!.getAttribute("data-model");

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
    // two orders of magnitude.
    await openPicker({
      ...one,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model({ dollarsPerMillion: 1.875 })],
    });
    expect(ui.$("#model-dialog .model-row .model-price")!.textContent).toBe("$1.88/M");
  });

  it("says nothing about a price that is not per-token", async () => {
    // The catalogue quotes a sentinel for models priced per request. Drawing
    // one as a figure would be inventing it.
    await openPicker({
      ...one,
      routerKey: { present: true, hint: "…4f2a" },
      models: [model({ id: "openrouter/auto", name: "Auto Router", dollarsPerMillion: null })],
    });
    expect(ui.$("#model-dialog .model-row .model-price")!.textContent).toBe("");
  });

  it("names the model without repeating the vendor a third time", async () => {
    // The vendor is already the heading the row sits under and already the
    // front of the id. Saying it again is what pushed rows onto two lines.
    await openPicker({
      ...one,
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
      routerKey: { present: true, hint: "…4f2a" },
      models: [...many(300), current],
    });
    expect(ui.$$("#model-dialog .model-row").map((r) => r.getAttribute("data-model")))
      .toContain("vendor299/model-299");
  });

  it("offers a way to add a key rather than only naming one", async () => {
    // The old note pointed at Settings and stopped there, which left the
    // developer inside a modal reading about something they could not go do.
    await openPicker({ ...one, models: [model()] });
    expect(ui.$("#model-dialog-need-key")).not.toBe(null);

    await ui.click(ui.$("#model-dialog-need-key"));
    await waitFor(() => ui.$<HTMLDialogElement>("#settings-dialog")?.open === true);
    expect(ui.$<HTMLDialogElement>("#model-dialog")!.open).toBe(false);
  });

  it("does not offer to add a key that is already there", async () => {
    await openPicker({ ...one, routerKey: { present: true, hint: "…4f2a" }, models: [model()] });
    expect(ui.$("#model-dialog-need-key")).toBe(null);
  });

  it("will not let a model be picked while there is no key to reach it", async () => {
    await openPicker({ ...one, models: [model()] });
    expect(ui.$<HTMLButtonElement>("#model-dialog .model-row")!.disabled).toBe(true);
  });

  it("still opens on Anthropic's four when OpenRouter will not answer", async () => {
    // Those go straight to Anthropic on the machine's own login, so a picker
    // that refused to open would be refusing over something that does not
    // affect them.
    await openPicker({ ...one, models: "unreachable" });
    expect(ui.$$("#model-dialog .model-option").length).toBe(4);
    expect(ui.$("#model-dialog-error")!.textContent).toContain("Anthropic's models still work");
  });
});
