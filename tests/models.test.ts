import { describe, it, expect } from "vitest";
import {
  MODELS,
  modelLabel,
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
