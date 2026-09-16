import { describe, it, expect } from "vitest";
import { offsetOf } from "../editor/vscode/src/reveal.js";

/**
 * Where in the file the specialist's own change is.
 *
 * Opening a 600-line file at line 1 to show three changed lines is a file you
 * already know, drawn again. The daemon sends the line it wrote; this finds
 * it, so the editor can scroll there. Matched as text rather than by a line
 * number because the file has usually moved on by the time it opens - another
 * edit a moment later shifts every line below it.
 */
describe("finding what a specialist just wrote", () => {
  const file = "const a = 1;\nfunction go() {\n  return compute(a);\n}\n";

  it("finds the written line where it sits, indentation and all", () => {
    // The daemon sends the line trimmed; in the file it is indented.
    expect(offsetOf(file, "return compute(a);")).toBe(file.indexOf("return compute(a);"));
  });

  it("takes the first occurrence, not a later one", () => {
    const twice = "x();\ny();\nx();\n";
    expect(offsetOf(twice, "x();")).toBe(0);
  });

  it("says nothing when the file has already moved past it", () => {
    // Not an error: the specialist wrote again before the editor opened it.
    // The file still opens, at the top, exactly as it did before.
    expect(offsetOf(file, "return compute(b);")).toBeNull();
  });

  it("says nothing when there is nothing to look for", () => {
    // `Write` and `NotebookEdit` send no line - a whole new file has no
    // region to jump to.
    expect(offsetOf(file, undefined)).toBeNull();
    expect(offsetOf(file, "")).toBeNull();
    expect(offsetOf(file, "   ")).toBeNull();
  });
});
