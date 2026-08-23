/**
 * Just enough markdown for what turns up in a thread.
 *
 * Every node is built rather than assigned as HTML. Thread bodies are written
 * by specialists and by the developer and are not trusted, so there is no
 * path from a message to executable markup - and that constraint, not the
 * feature set, is the point of writing this instead of taking a library.
 *
 * It is deliberately not CommonMark: no tables, no nested lists, no reference
 * links. Anything with real structure is meant to be a report, which is HTML
 * in its own sandboxed frame.
 */

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const QUOTE = /^\s*>\s?/;
const FENCE = /^\s*```(\S*)\s*$/;
const CLOSING_FENCE = /^\s*```\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** Only what a browser will navigate to safely. Anything else - javascript:,
 * data:, a bare path - stays as the text it was written as. */
const SAFE_HREF = /^https?:\/\//i;

/** A bare issue or pull request number, not preceded by a word character -
 * so `sha#12` and a heading's `#` are left alone. */
const REFERENCE = /(?<![\w#])(#\d+)/g;

/** What a number in a thread turns out to be about. */
export interface Reference { number: number; title: string; url: string }
export type References = ReadonlyMap<number, Reference>;

/** Every `#12` in the text, in the order they appear. */
export function referencedNumbers(text: string): number[] {
  return [...new Set(
    [...String(text ?? "").matchAll(REFERENCE)].map((m) => Number(m[1].slice(1))),
  )];
}

/**
 * `#12` says nothing. What the developer needs from a thread is what the
 * number is about, so a resolved reference reads as its title with the number
 * beside it, linked - and an unresolved one stays the text it always was.
 */
function renderReferences(parent: Node, text: string, refs: References | undefined): void {
  if (!refs || refs.size === 0) { parent.appendChild(document.createTextNode(text)); return; }

  for (const part of text.split(REFERENCE)) {
    if (!part) continue;

    const ref = /^#\d+$/.test(part) ? refs.get(Number(part.slice(1))) : undefined;
    // The daemon supplies these, but the rule is the same as for a written
    // link: nothing the browser will not navigate to safely.
    if (!ref || !SAFE_HREF.test(ref.url)) {
      parent.appendChild(document.createTextNode(part));
      continue;
    }

    const title = document.createElement("strong");
    title.className = "ref-title";
    title.textContent = ref.title;

    const anchor = document.createElement("a");
    anchor.className = "ref-number";
    anchor.href = ref.url;
    anchor.textContent = part;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";

    const wrap = document.createElement("span");
    wrap.className = "ref";
    wrap.append(title, " ", anchor);
    parent.appendChild(wrap);
  }
}

function renderInline(parent: Node, text: string, refs?: References): void {
  // Splitting on a capturing pattern returns the delimiters interleaved with
  // the plain runs between them.
  for (const part of text.split(INLINE)) {
    if (!part) continue;

    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
      continue;
    }

    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      renderInline(strong, part.slice(2, -2), refs);
      parent.appendChild(strong);
      continue;
    }

    const italic = part.length > 2
      && ((part.startsWith("*") && part.endsWith("*"))
        || (part.startsWith("_") && part.endsWith("_")));
    if (italic) {
      const em = document.createElement("em");
      renderInline(em, part.slice(1, -1), refs);
      parent.appendChild(em);
      continue;
    }

    const link = LINK.exec(part);
    if (link && SAFE_HREF.test(link[2])) {
      const anchor = document.createElement("a");
      anchor.href = link[2];
      anchor.textContent = link[1];
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      parent.appendChild(anchor);
      continue;
    }

    renderReferences(parent, part, refs);
  }
}

export function renderMarkdown(text: string, refs?: References): DocumentFragment {
  const root = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const held: string[] = [];
  let i = 0;

  // A single newline inside a paragraph stays a line break. Chat is written
  // in lines, and reflowing them loses the shape the writer gave it.
  const flush = () => {
    if (held.length === 0) return;
    const paragraph = document.createElement("p");
    held.forEach((line, index) => {
      if (index > 0) paragraph.appendChild(document.createElement("br"));
      renderInline(paragraph, line, refs);
    });
    root.appendChild(paragraph);
    held.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !CLOSING_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence, or the end of the text
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = body.join("\n");
      pre.appendChild(code);
      root.appendChild(pre);
      continue;
    }

    if (line.trim() === "") { flush(); i += 1; continue; }

    if (RULE.test(line)) {
      flush();
      root.appendChild(document.createElement("hr"));
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      // A bubble is not a document: the largest heading in one is an h3.
      const h = document.createElement(`h${Math.min(6, heading[1].length + 2)}`);
      renderInline(h, heading[2], refs);
      root.appendChild(h);
      i += 1;
      continue;
    }

    if (BULLET.test(line)) {
      flush();
      const ordered = ORDERED.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && BULLET.test(lines[i]) && ORDERED.test(lines[i]) === ordered) {
        const item = document.createElement("li");
        renderInline(item, lines[i].replace(BULLET, ""), refs);
        list.appendChild(item);
        i += 1;
      }
      root.appendChild(list);
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ""));
        i += 1;
      }
      const quote = document.createElement("blockquote");
      quote.appendChild(renderMarkdown(body.join("\n"), refs));
      root.appendChild(quote);
      continue;
    }

    held.push(line);
    i += 1;
  }

  flush();
  return root;
}
