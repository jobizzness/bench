import { describe, it, expect } from "vitest";
import {
  MODELS,
  DEVIN_MODEL,
  DEVIN_PREFIX,
  devinFamilyOf,
  isDevinModel,
  modelLabel,
  runningModelLabel,
  isProxied,
  isModelId,
  DEFAULT_MODEL,
} from "../src/shared/models.js";

describe("the models this file names", () => {
  it("is Anthropic's four, and only those", () => {
    // Everything else now comes from OpenRouter at runtime. A hand-kept list
    // of other people's models is one that goes stale invisibly - this file
    // once named Gemini versions that no longer existed, and nothing about it
    // looked wrong.
    expect(MODELS.map((m) => m.id)).toEqual(["opus", "sonnet", "fable", "haiku"]);
    expect(DEFAULT_MODEL).toBe("opus");
  });

  it("has no duplicate ids", () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });
});

describe("which models need OpenRouter", () => {
  it("is decided by the slash", () => {
    expect(isProxied("google/gemini-3.7-flash")).toBe(true);
    expect(isProxied("opus")).toBe(false);
    expect(isProxied("claude-opus-5")).toBe(false);
  });
});

describe("what this bench will accept as a model", () => {
  it("takes its own four", () => {
    for (const id of ["opus", "sonnet", "fable", "haiku"]) {
      expect(isModelId(id)).toBe(true);
    }
  });

  it("takes any OpenRouter id on its shape", () => {
    // Not checked against the catalogue: that is a network call, this runs on
    // every save, and a model OpenRouter has never heard of comes back as its
    // own clear error from the one place that can actually say so.
    expect(isModelId("google/gemini-3.7-flash")).toBe(true);
    expect(isModelId("some-vendor/some-model")).toBe(true);
  });

  it("refuses what is neither", () => {
    expect(isModelId("gpt-2")).toBe(false);
    expect(isModelId("")).toBe(false);
    expect(isModelId(null)).toBe(false);
  });
});

describe("what a model is called", () => {
  it("uses the friendly name for Anthropic's", () => {
    expect(modelLabel("opus")).toBe("Opus 5");
    expect(modelLabel("haiku")).toBe("Haiku 4.5");
  });

  it("drops the vendor prefix from an OpenRouter id", () => {
    // The vendor is already the heading it sits under, so repeating it in
    // every row is noise.
    expect(modelLabel("google/gemini-3.7-flash")).toBe("gemini-3.7-flash");
  });

  it("shows a name it has never heard of as itself", () => {
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
  });
});

describe("what a specialist is actually running on", () => {
  it("is just the model, pinned", () => {
    expect(runningModelLabel("haiku", null)).toBe("Haiku 4.5");
    expect(runningModelLabel("google/gemini-3.7-flash", null)).toBe("gemini-3.7-flash");
  });

  it("is the router's own name, on an auto router that has not answered yet", () => {
    expect(runningModelLabel("openrouter/auto", null)).toBe("auto");
    expect(runningModelLabel("openrouter/auto", [])).toBe("auto");
  });

  it("is what actually answered, tagged as auto, once it has", () => {
    expect(runningModelLabel("openrouter/auto", ["z-ai/glm-5.2"])).toBe("glm-5.2 <auto>");
  });

  it("uses the first model where a router answered under more than one", () => {
    expect(runningModelLabel("openrouter/auto", ["z-ai/glm-5.2", "deepseek/deepseek-v4-flash"]))
      .toBe("glm-5.2 <auto>");
  });

  it("leaves a pinned model alone even if answeredBy is somehow set", () => {
    // Should not happen - a model that answers for itself has nothing to
    // report there - but a stale field must not lie about what is pinned.
    expect(runningModelLabel("haiku", ["haiku"])).toBe("Haiku 4.5");
  });
});

describe("devin as a third-kind model id", () => {
  it("is accepted by isModelId", () => {
    expect(isModelId(DEVIN_MODEL)).toBe(true);
  });

  it("is not proxied through OpenRouter — a slash decides that, and devin has none", () => {
    expect(isProxied(DEVIN_MODEL)).toBe(false);
  });

  it("has a human-readable label", () => {
    expect(modelLabel(DEVIN_MODEL)).toBe("Devin");
  });

  it("is not in MODELS — that array is Anthropic aliases only", () => {
    // Adding it there would pass it to `claude --model`, which does not
    // understand it and would silently fall back to some other model.
    expect(MODELS.some((m) => m.id === DEVIN_MODEL)).toBe(false);
  });
});

describe("Devin's own models, namespaced under it (#114)", () => {
  it("is accepted by isModelId", () => {
    expect(isModelId("devin:adaptive")).toBe(true);
    expect(isModelId("devin:opus")).toBe(true);
    expect(isModelId("devin:swe-2")).toBe(true);
  });

  it("refuses the bare prefix with nothing after it", () => {
    expect(isModelId(DEVIN_PREFIX)).toBe(false);
    expect(isModelId("devin:")).toBe(false);
  });

  it("is not proxied through OpenRouter — a colon, not a slash, on purpose", () => {
    // isProxied treats any id containing "/" as an OpenRouter model, which
    // would make every Devin model demand an OpenRouter key. That is the
    // whole reason the namespace is "devin:adaptive", not "devin/adaptive".
    expect(isProxied("devin:adaptive")).toBe(false);
    expect(isProxied("devin:swe-2")).toBe(false);
  });

  it("has a human-readable label naming the family", () => {
    expect(modelLabel("devin:adaptive")).toBe("Devin: adaptive");
  });

  it("is recognised by isDevinModel, bare or namespaced", () => {
    expect(isDevinModel(DEVIN_MODEL)).toBe(true);
    expect(isDevinModel("devin:adaptive")).toBe(true);
    expect(isDevinModel("opus")).toBe(false);
    expect(isDevinModel("google/gemini-3.7-flash")).toBe(false);
  });

  it("extracts the family devin acp --model wants, from a namespaced id", () => {
    expect(devinFamilyOf("devin:adaptive")).toBe("adaptive");
    expect(devinFamilyOf("devin:swe-2")).toBe("swe-2");
  });

  it("has no family to extract from the bare account default", () => {
    // Undefined, not "", so a caller can tell "nothing to override" apart
    // from a genuinely empty string it would have to reject.
    expect(devinFamilyOf(DEVIN_MODEL)).toBeUndefined();
    expect(devinFamilyOf("opus")).toBeUndefined();
  });
});

describe("what a specialist is actually running on, for Devin", () => {
  it("shows the bare account default until a turn has resolved it", () => {
    expect(runningModelLabel(DEVIN_MODEL, null)).toBe("Devin");
    expect(runningModelLabel(DEVIN_MODEL, [])).toBe("Devin");
  });

  it("shows what the account default actually resolved to, once a turn has", () => {
    // Bare "devin" names no model at all - swe-2-high is what the ticket's
    // own capture off the live binary showed it silently running on.
    expect(runningModelLabel(DEVIN_MODEL, ["swe-2-high"])).toBe("swe-2-high");
  });

  it("shows what a named family resolved to, not tagged <auto>", () => {
    // Unlike openrouter/auto, picking devin:adaptive was a real choice, so
    // the resolved variant is shown plainly rather than annotated as one.
    expect(runningModelLabel("devin:adaptive", ["adaptive-high"])).toBe("adaptive-high");
  });

  it("falls back to the family name before any turn has answered", () => {
    expect(runningModelLabel("devin:adaptive", null)).toBe("Devin: adaptive");
  });
});
