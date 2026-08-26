/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * What this turn will be spent on, said at the foot of the composer.
 *
 * It used to be a badge in the stage header. It is here now because this is
 * the line you read as you decide to send: the model and what is left of it
 * are one question, and the header was answering half of it somewhere else.
 */

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

const said = () => ui.$("#composer-model")?.textContent;

describe("the model at the foot of the composer", () => {
  it("says what the specialist you are typing to runs on", async () => {
    ui = await bootCockpit({ rows: [row({ label: "auth", model: "haiku" })] });
    await ui.open("auth");

    expect(said()).toBe("Haiku 4.5");
  });

  it("follows the specialist you switch to", async () => {
    ui = await bootCockpit({ rows: [
      row({ id: "s1", label: "auth", model: "opus" }),
      row({ id: "s2", label: "billing", model: "sonnet" }),
    ] });

    await ui.open("auth");
    expect(said()).toBe("Opus 5");

    await ui.open("billing");
    expect(said()).toBe("Sonnet 5");
  });

  it("says a model this cockpit has never heard of as itself", async () => {
    // The CLI takes full model names, and a specialist made with one is still
    // a specialist. Saying nothing would be a lie about the box you are
    // typing into.
    ui = await bootCockpit({ rows: [row({ label: "auth", model: "claude-fable-5" })] });
    await ui.open("auth");

    expect(said()).toBe("claude-fable-5");
  });

  it("says nothing with nobody on the stage", async () => {
    ui = await bootCockpit({ rows: [] });

    expect(said()).toBeUndefined();
  });

  it("says nothing for a row from a daemon that predates the field", async () => {
    const { model, ...older } = row({ label: "auth" });
    ui = await bootCockpit({ rows: [older as ReturnType<typeof row>] });
    await ui.open("auth");

    expect(said()).toBeUndefined();
  });
});
