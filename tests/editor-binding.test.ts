import { describe, it, expect } from "vitest";
import { targetFolder, effectiveFolders } from "../editor/vscode/src/binding.js";

/**
 * What the cockpit's button actually changes (#129).
 *
 * The developer opens VS Code themselves, so this never launches anything.
 * It narrows which project a window speaks for - which matters because one
 * daemon serves them all, and a window with two folders open otherwise
 * follows both at once.
 */
describe("taking a target", () => {
  it("takes a project this window has open", () => {
    expect(targetFolder("/var/www/bench", ["/var/www/bench"])).toBe("/var/www/bench");
  });

  it("takes one of several folders this window has open", () => {
    expect(targetFolder("/var/www/other", ["/var/www/bench", "/var/www/other"]))
      .toBe("/var/www/other");
  });

  /**
   * The frame goes to every connected editor, because the daemon has no way
   * to tell which window the developer meant. A window that does not have
   * that project open is not the one being talked to.
   */
  it("ignores a target for a project this window does not have open", () => {
    expect(targetFolder("/var/www/elsewhere", ["/var/www/bench"])).toBeNull();
  });

  it("is not fooled by a sibling with the same prefix", () => {
    expect(targetFolder("/var/www/bench-old", ["/var/www/bench"])).toBeNull();
  });

  /** A window opened on a subdirectory of the project still serves it. */
  it("takes a project that contains a folder this window has open", () => {
    expect(targetFolder("/var/www/bench", ["/var/www/bench/src"])).toBe("/var/www/bench");
  });

  it("takes nothing when no folder is open", () => {
    expect(targetFolder("/var/www/bench", [])).toBeNull();
  });
});

describe("what a window is following", () => {
  it("follows everything it has open until it is told otherwise", () => {
    expect(effectiveFolders(null, ["/var/www/bench", "/var/www/other"]))
      .toEqual(["/var/www/bench", "/var/www/other"]);
  });

  it("follows only the project it was targeted at", () => {
    expect(effectiveFolders("/var/www/other", ["/var/www/bench", "/var/www/other"]))
      .toEqual(["/var/www/other"]);
  });
});
