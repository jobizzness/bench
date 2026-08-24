import { describe, it, expect } from "vitest";
import { labelIsUsable, slugify, LABEL_MAX } from "../src/shared/slug.js";

/**
 * A label is what a person calls a specialist. A slug is what git can hold.
 * These were the same string, which meant the developer typed a branch name
 * and we called it a label.
 */

describe("what a person may call a specialist", () => {
  it("takes what anyone would actually write", () => {
    expect(labelIsUsable("Password reset (v2)")).toBe(true);
    expect(labelIsUsable("Cash pickup — SEPA")).toBe(true);
    expect(labelIsUsable("直接支払い")).toBe(true);
  });

  it("refuses only nothing, and a name longer than a line", () => {
    expect(labelIsUsable("")).toBe(false);
    expect(labelIsUsable("   ")).toBe(false);
    expect(labelIsUsable("a".repeat(LABEL_MAX + 1))).toBe(false);
  });
});

describe("what git is given instead", () => {
  it("keeps the words and drops everything else", () => {
    expect(slugify("Password reset (v2)")).toBe("password-reset-v2");
    expect(slugify("Cash pickup — SEPA")).toBe("cash-pickup-sepa");
  });

  it("folds accents rather than dropping the word", () => {
    expect(slugify("Café update")).toBe("cafe-update");
  });

  it("cannot produce a path or a ref that traverses", () => {
    // The whole reason the old rule existed. It holds by construction now.
    expect(slugify("../../etc")).toBe("etc");
    expect(slugify("a/b/c")).toBe("a-b-c");
    expect(slugify(".git")).toBe("git");
  });

  it("always produces something nameable", () => {
    // A label of pure punctuation still has to make a branch.
    expect(slugify("!!!")).toBe("specialist");
    expect(slugify("直接支払い")).toBe("specialist");
  });

  it("never ends on a hyphen, however it was cut", () => {
    expect(slugify("a".repeat(60) + " tail")).not.toMatch(/-$/);
    expect(slugify("trailing -")).toBe("trailing");
  });
});
