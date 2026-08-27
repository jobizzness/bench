import { describe, it, expect } from "vitest";
import { AUTO_ROUTERS, isAutoRouter, inheritedModel } from "../src/shared/auto-routers.js";

describe("the auto routers", () => {
  it("knows the two routers by id, and nothing else", () => {
    expect(isAutoRouter("openrouter/auto")).toBe(true);
    expect(isAutoRouter("openrouter/auto-beta")).toBe(true);
    // A pinned model, Anthropic's or OpenRouter's, is not a router.
    expect(isAutoRouter("opus")).toBe(false);
    expect(isAutoRouter("deepseek/deepseek-v4-coder")).toBe(false);
  });

  it("lists exactly the routers the picker offers", () => {
    expect(AUTO_ROUTERS.map((r) => r.id)).toEqual(["openrouter/auto", "openrouter/auto-beta"]);
  });
});

describe("what a child inherits from its parent", () => {
  it("inherits the router when the parent is routed per request", () => {
    // Auto mode is not a model choice, so it is the one thing that should
    // follow into a tab the parent opens rather than be reset by the role.
    expect(inheritedModel("openrouter/auto")).toBe("openrouter/auto");
    expect(inheritedModel("openrouter/auto-beta")).toBe("openrouter/auto-beta");
  });

  it("sends nothing for a parent pinned to a model, so the role decides", () => {
    // A parent on Opus made a decision about itself, not a default for every
    // specialist it staffs - the child gets its own role's answer.
    expect(inheritedModel("opus")).toBeUndefined();
    expect(inheritedModel("deepseek/deepseek-v4-coder")).toBeUndefined();
  });

  it("sends nothing when the parent did not say what it is", () => {
    expect(inheritedModel(undefined)).toBeUndefined();
  });
});
