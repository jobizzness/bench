import { describe, it, expect } from "vitest";
import { blockedMessage, updateAction, type UpdateInputs } from "../src/shared/self-update.js";

const BOOT = "aaa111";
const HEAD_SAME = "aaa111";
const HEAD_MOVED = "bbb222";

const row = (over: Partial<UpdateInputs>): UpdateInputs => ({
  behind: 0, dirty: false, fastForward: true, bootSha: BOOT, headSha: HEAD_SAME, ...over,
});

describe("updateAction", () => {
  it("is none when level with origin and still on the boot commit", () => {
    expect(updateAction(row({}))).toEqual({ kind: "none" });
  });

  it("is update, naming how far behind, when level with the boot commit but behind origin", () => {
    expect(updateAction(row({ behind: 3 }))).toEqual({ kind: "update", behind: 3 });
  });

  it("is blocked on a dirty tree, even though a fast-forward would otherwise work", () => {
    expect(updateAction(row({ behind: 3, dirty: true }))).toEqual({ kind: "blocked", reason: "dirty" });
  });

  it("is blocked as diverged when the merge would not fast-forward", () => {
    expect(updateAction(row({ behind: 3, fastForward: false }))).toEqual({ kind: "blocked", reason: "diverged" });
  });

  it("prefers dirty over diverged when both are true - one reason is said, not two", () => {
    expect(updateAction(row({ behind: 3, dirty: true, fastForward: false })))
      .toEqual({ kind: "blocked", reason: "dirty" });
  });

  it("is restart once HEAD has moved past the boot commit, even though behind is back to zero", () => {
    expect(updateAction(row({ headSha: HEAD_MOVED }))).toEqual({ kind: "restart" });
  });

  it("is restart even while a further update is also available - restarting is the more urgent of the two", () => {
    expect(updateAction(row({ headSha: HEAD_MOVED, behind: 2 }))).toEqual({ kind: "restart" });
  });

  it("is restart regardless of a dirty tree - a stale process outranks a stale checkout", () => {
    expect(updateAction(row({ headSha: HEAD_MOVED, dirty: true }))).toEqual({ kind: "restart" });
  });
});

describe("blockedMessage", () => {
  it("names the tree as dirty", () => {
    expect(blockedMessage("dirty")).toMatch(/uncommitted changes/);
  });

  it("names the branch as diverged", () => {
    expect(blockedMessage("diverged")).toMatch(/diverged/);
  });
});
