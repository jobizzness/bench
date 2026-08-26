import { describe, it, expect } from "vitest";
import { ROLE_MODELS, fellBack, modelForRole } from "../src/shared/role-models.js";
import { ROLES } from "../src/shared/roles.js";
import { isProxied } from "../src/shared/models.js";

/**
 * What each kind of work runs on.
 *
 * Every specialist used to start on Opus because that was the only default
 * there was, so a researcher reading docs cost the same as a planner deciding
 * what to build. The role is the one thing Bench knows about a tab before it
 * has done anything, and it is the thing that should choose.
 */

describe("the table itself", () => {
  it("has an answer for every role, so nothing falls through to Opus by accident", () => {
    for (const role of ROLES) {
      expect(ROLE_MODELS[role]?.preferred, role).toBeTruthy();
      expect(ROLE_MODELS[role]?.because, role).toBeTruthy();
    }
  });

  it("falls back to something this machine's own login can run", () => {
    // The fallback exists for a bench with no OpenRouter key. One that needs
    // a key to work is not a fallback.
    for (const role of ROLES) {
      expect(isProxied(ROLE_MODELS[role]!.direct), role).toBe(false);
    }
  });

  it("keeps planning on a flagship, and never routes it", () => {
    // Routing Opus through OpenRouter would move the spend off a
    // subscription that is already paid for and onto a card.
    expect(ROLE_MODELS.planner.preferred).toBe("opus");
    expect(isProxied(ROLE_MODELS.planner.preferred)).toBe(false);
  });
});

describe("choosing the model for a role", () => {
  it("is the built-in answer when nobody has said otherwise", () => {
    expect(modelForRole("researcher", { viaRouter: true }))
      .toBe("deepseek/deepseek-v4-flash");
  });

  it("is the developer's own answer when they have given one", () => {
    expect(modelForRole("researcher", { chosen: "haiku", viaRouter: true })).toBe("haiku");
  });

  it("falls back to something direct when there is no key to reach the other", () => {
    // The alternative is running Opus at twenty times the price because a one
    // cent model was unreachable, and saying nothing about it.
    expect(modelForRole("reviewer", { viaRouter: false })).toBe("haiku");
    expect(modelForRole("implementer", { viaRouter: false })).toBe("sonnet");
  });

  it("says when that has happened, so the fallback is never silent", () => {
    expect(fellBack("reviewer", { viaRouter: false })).toBe(true);
    expect(fellBack("reviewer", { viaRouter: true })).toBe(false);
    expect(fellBack("planner", { viaRouter: false })).toBe(false);
  });

  it("falls back from the developer's own choice too, not only from ours", () => {
    expect(modelForRole("researcher", { chosen: "x-ai/grok-5", viaRouter: false })).toBe("haiku");
    expect(fellBack("researcher", { chosen: "x-ai/grok-5", viaRouter: false })).toBe(true);
  });

  it("leaves a direct choice alone whether or not there is a key", () => {
    expect(modelForRole("researcher", { chosen: "opus", viaRouter: false })).toBe("opus");
    expect(fellBack("researcher", { chosen: "opus", viaRouter: false })).toBe(false);
  });
});
