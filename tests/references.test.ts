/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown, referencedNumbers, type References } from "../src/client/markdown.js";

/**
 * "#12" tells the developer nothing. The thread is where they read what a
 * specialist has been doing, and half of it was numbers they had to go and
 * look up somewhere else.
 */

const refs: References = new Map([
  [12, { number: 12, title: "The composer", url: "https://github.com/o/r/pull/12" }],
  [8, { number: 8, title: "Composer: hover and images", url: "https://github.com/o/r/issues/8" }],
]);

/** Passing the map explicitly, so "nothing resolved yet" can be said. */
function renderWith(text: string, known?: References): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(text, known));
  return host;
}

const render = (text: string, known: References = refs) => renderWith(text, known);

describe("finding the numbers", () => {
  it("picks out every mention once", () => {
    expect(referencedNumbers("closes #8, see also #12 and #8 again")).toEqual([8, 12]);
  });

  it("leaves alone what is not a reference", () => {
    // A heading, a colour, and a number welded to a word.
    expect(referencedNumbers("# Heading\ncolour #fff\nabc#12")).toEqual([]);
  });
});

describe("what a number renders as", () => {
  it("says what it is about, with the number as the link", () => {
    const host = render("landed in #12 this morning");

    expect(host.querySelector(".ref-title")!.textContent).toBe("The composer");
    const anchor = host.querySelector<HTMLAnchorElement>("a.ref-number")!;
    expect(anchor.textContent).toBe("#12");
    expect(anchor.href).toBe("https://github.com/o/r/pull/12");
    expect(anchor.target).toBe("_blank");
  });

  it("leaves an unresolved number as the text it always was", async () => {
    // Offline, private, deleted, or simply not a real issue: all the same
    // here. The thread still reads.
    const host = render("see #99");

    expect(host.querySelector(".ref")).toBeNull();
    expect(host.textContent).toContain("#99");
  });

  it("keeps the rest of the sentence around it", () => {
    expect(render("landed in #12 this morning").textContent)
      .toBe("landed in The composer #12 this morning");
  });

  it("resolves several in one line, and inside a list", () => {
    const host = render("- #8 and #12\n");
    expect(host.querySelectorAll("li .ref").length).toBe(2);
  });

  it("does not touch a number inside code", () => {
    // `#12` in a command is part of the command.
    const host = render("run `git show #12`");
    expect(host.querySelector(".ref")).toBeNull();
    expect(host.querySelector("code")!.textContent).toBe("git show #12");
  });

  it("does not turn a heading into a reference", () => {
    const host = render("## What changed");
    expect(host.querySelector(".ref")).toBeNull();
    expect(host.querySelector("h4")!.textContent).toBe("What changed");
  });

  it("renders as plain text when nothing has been resolved yet", () => {
    // The first render happens before the daemon has answered, and it must
    // not flash a half-formed reference.
    expect(renderWith("see #12").textContent).toBe("see #12");
  });

  it("refuses a link the browser should not follow", () => {
    const hostile: References = new Map([
      [12, { number: 12, title: "nice try", url: "javascript:alert(1)" }],
    ]);
    const host = render("see #12", hostile);

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("see #12");
  });
});
