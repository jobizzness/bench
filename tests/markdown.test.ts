/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/client/markdown.js";

/** Render into a host so the result can be inspected as a tree. */
function render(text: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(text));
  return host;
}

const html = (text: string) => render(text).innerHTML;

describe("renderMarkdown", () => {
  it("renders emphasis rather than showing its punctuation", () => {
    // This is what the thread was doing to every specialist reply.
    expect(html("**done**")).toContain("<strong>done</strong>");
    expect(html("_maybe_")).toContain("<em>maybe</em>");
  });

  it("renders inline code", () => {
    expect(html("run `pnpm test` first")).toContain("<code>pnpm test</code>");
  });

  it("keeps a fenced block whole, with its language", () => {
    const host = render("```ts\nconst a = 1;\nconst b = 2;\n```");
    const code = host.querySelector("pre code")!;
    expect(code.textContent).toBe("const a = 1;\nconst b = 2;");
    expect((code as HTMLElement).dataset.lang).toBe("ts");
  });

  it("does not treat markdown inside a code fence as markdown", () => {
    const host = render("```\n**not bold**\n```");
    expect(host.querySelector("strong")).toBeNull();
    expect(host.querySelector("pre code")!.textContent).toBe("**not bold**");
  });

  it("renders bullet and ordered lists", () => {
    expect(render("- one\n- two").querySelectorAll("ul li")).toHaveLength(2);
    expect(render("1. one\n2. two").querySelectorAll("ol li")).toHaveLength(2);
  });

  it("keeps a single newline as a line break inside a paragraph", () => {
    // Chat is written in lines; reflowing them loses the shape.
    const host = render("first\nsecond");
    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("br")).toHaveLength(1);
  });

  it("starts a new paragraph on a blank line", () => {
    expect(render("first\n\nsecond").querySelectorAll("p")).toHaveLength(2);
  });

  it("demotes headings, because a bubble is not a document", () => {
    expect(render("# Title").querySelector("h3")).not.toBeNull();
    expect(render("## Sub").querySelector("h4")).not.toBeNull();
  });

  it("renders a blockquote, markdown and all", () => {
    const quote = render("> **quoted**").querySelector("blockquote")!;
    expect(quote.querySelector("strong")!.textContent).toBe("quoted");
  });

  it("renders a horizontal rule", () => {
    expect(render("---").querySelector("hr")).not.toBeNull();
  });
});

describe("renderMarkdown with untrusted text", () => {
  // Thread bodies are written by specialists and by the developer. There must
  // be no path from a message to executable markup.

  it("never interprets raw HTML", () => {
    const host = render("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes a script tag into text", () => {
    const host = render("<script>alert(1)</script>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.innerHTML).not.toContain("<script>");
  });

  it("refuses a javascript: link and leaves it as text", () => {
    const host = render("[click](javascript:alert(1))");
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("[click](javascript:alert(1))");
  });

  it("refuses a data: link", () => {
    const host = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(host.querySelector("a")).toBeNull();
  });

  it("allows an http link, opened safely", () => {
    const anchor = render("[docs](https://example.com/x)").querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/x");
    expect(anchor.rel).toBe("noopener noreferrer");
    expect(anchor.target).toBe("_blank");
  });

  it("keeps HTML inside a code fence as text", () => {
    const host = render("```\n<script>alert(1)</script>\n```");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("pre code")!.textContent).toBe("<script>alert(1)</script>");
  });

  it("survives an unclosed fence without losing the rest", () => {
    const host = render("```\nunclosed");
    expect(host.querySelector("pre code")!.textContent).toBe("unclosed");
  });

  it("handles empty text", () => {
    expect(render("").childNodes).toHaveLength(0);
  });
});
