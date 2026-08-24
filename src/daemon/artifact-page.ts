/**
 * The page an agent's fragment is rendered into.
 *
 * The skills ask for a fragment - no html, head or body - and the frame owns
 * everything around it. That is deliberate: an agent writing semantic HTML
 * gets a designed document for free, and a report is not improved by every
 * specialist inventing its own typography.
 *
 * Rendered under `default-src 'none'; font-src data:`, so there are no web
 * fonts and no scripts. The pairing is the decision: prose is set in a serif
 * and evidence in mono, because a report is a document you read once and
 * decide from, not a transcript - and every developer tool defaults to
 * all-sans. Anything the agent sets itself comes later in the cascade and
 * still wins.
 */
const GROUND = `
  :root {
    --ground: #16211c;
    --raised: rgba(255,255,255,0.035);
    --line: rgba(255,255,255,0.09);
    --firm: rgba(255,255,255,0.17);
    --text: #e8efe9;
    --muted: #8ba396;
    --faint: #5f7a6c;
    --accent: #4fd18b;
    /* The only second hue, spent on the one section that earns it. */
    --unverified: #e0b155;

    --prose: "Iowan Old Style", Georgia, ui-serif, serif;
    --label: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;

    color-scheme: dark;
  }

  /* A report is long by nature, so its scrollbar is always on screen. The same
     thin inset thumb as the cockpit, rather than the 16px stepper the UA
     draws. See the note in styles.css for why these and not the standard
     scrollbar properties. */
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-button { display: none; }
  *::-webkit-scrollbar-thumb {
    background: var(--firm);
    background-clip: padding-box;
    border: 3px solid transparent;
    border-radius: 999px;
  }
  *::-webkit-scrollbar-thumb:hover { background: var(--muted); background-clip: padding-box; }

  html { background: var(--ground); }
  body {
    margin: 0 auto;
    /* A measure, not a viewport. Prose running the full width of a wide
       window is the single biggest thing standing between a report and
       being read. */
    max-width: 68ch;
    padding: 34px 26px 56px;
    background: var(--ground);
    color: var(--text);
    font-family: var(--prose);
    font-size: 15px;
    line-height: 1.62;
    text-rendering: optimizeLegibility;
  }

  /* ── The ask ─────────────────────────────────────────────────────── */

  h1 {
    font-size: 27px;
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.012em;
    margin: 0 0 18px;
    color: #f4faf5;
  }

  /* The paragraph after the title is the ask. It carries the decision, so
     it is set larger than the body that follows it. */
  h1 + p {
    font-size: 16.5px;
    line-height: 1.58;
    color: var(--text);
    margin: 0 0 26px;
  }

  h2 {
    font-family: var(--label);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 34px 0 12px;
    padding-bottom: 7px;
    border-bottom: 1px solid var(--line);
  }

  h3 {
    font-size: 15.5px;
    font-weight: 600;
    margin: 22px 0 6px;
    color: #f0f6f1;
  }

  h4 { font-size: 14px; font-weight: 600; margin: 18px 0 4px; color: var(--text); }

  p { margin: 0 0 14px; }
  strong { font-weight: 600; color: #f4faf5; }
  em { font-style: italic; color: var(--text); }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(79,209,139,0.35); }
  a:hover { border-bottom-color: var(--accent); }

  ul, ol { margin: 0 0 16px; padding-left: 1.35em; }
  li { margin: 0 0 7px; }
  li::marker { color: var(--faint); }

  /* ── Evidence ────────────────────────────────────────────────────── */

  code {
    font-family: var(--mono);
    font-size: 0.855em;
    background: rgba(255,255,255,0.07);
    padding: 0.12em 0.36em;
    border-radius: 3px;
    color: #d7e6da;
  }

  /* Quoted from the machine rather than written by it: an inset ground and
     a rule, so a diff reads as something produced, not something claimed. */
  pre {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    background: rgba(0,0,0,0.28);
    border-left: 2px solid var(--firm);
    border-radius: 0 4px 4px 0;
    padding: 13px 15px;
    margin: 0 0 18px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; font-size: inherit; color: #cfe2d4; }

  blockquote {
    margin: 0 0 18px;
    padding: 2px 0 2px 15px;
    border-left: 2px solid var(--line);
    color: var(--muted);
    font-style: italic;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 20px;
    font-size: 14px;
  }
  th {
    font-family: var(--label);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
    text-align: left;
    padding: 0 14px 7px 0;
    border-bottom: 1px solid var(--firm);
  }
  td {
    padding: 9px 14px 9px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: 0; }

  hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0; }
  img { max-width: 100%; border-radius: 4px; display: block; }

  /* A screenshot is evidence, so it is framed like evidence: full measure,
     a hairline round it so a dark screenshot has an edge, and a caption that
     says what you are looking at. A picture with no caption is decoration. */
  figure {
    margin: 22px 0;
    /* At the measure, not breaking out of it. Widening a figure past the
       column needs arithmetic against the viewport that goes wrong in a
       narrow frame, and a screenshot at 68ch is legible - which was the only
       thing the breakout was for. */
  }
  figure img { border: 1px solid var(--line); }
  figcaption {
    margin-top: 8px;
    font-family: var(--label);
    font-size: 12.5px;
    color: var(--faint);
  }
  /* Two shots side by side - before and after, which is the pair most worth
     showing. They stack when the frame is narrow. */
  figure[data-bench="pair"] { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
  figure[data-bench="pair"] figcaption { grid-column: 1 / -1; }
  @media (max-width: 720px) {
    figure[data-bench="pair"] { grid-template-columns: 1fr; }
  }

  /* The one-line answer, for a report whose whole point is a verdict. It sits
     under the title and is the only thing besides it that is allowed to be
     large. */
  [data-bench="verdict"] {
    /* Not a flex row: the bold clause and the sentence after it are one
       sentence, and flex breaks "Ready to merge." over two lines the moment
       the box is narrow. */
    margin: 0 0 22px;
    padding: 14px 16px;
    border-left: 2px solid var(--accent);
    background: var(--raised);
    border-radius: 3px 8px 8px 3px;
    font-family: var(--label);
    font-size: 15px;
    color: var(--text);
  }
  [data-bench="verdict"][data-tone="bad"] { border-left-color: var(--unverified); }
  [data-bench="verdict"] strong { color: var(--accent); margin-right: 6px; }
  [data-bench="verdict"][data-tone="bad"] strong { color: var(--unverified); }

  /* Numbers worth reading at a glance rather than in a sentence: tests run,
     files touched, what it cost. */
  [data-bench="figures"] {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 28px;
    margin: 0 0 24px;
    padding: 0;
    list-style: none;
  }
  [data-bench="figures"] li { display: flex; flex-direction: column; gap: 3px; }
  [data-bench="figures"] b {
    font-family: var(--label);
    font-size: 19px;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  [data-bench="figures"] span {
    font-family: var(--label);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--faint);
  }

  /* Detail most readings will not need. A control, so it looks like one. */
  details {
    margin: 0 0 18px;
    padding: 11px 14px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 5px;
  }
  details[open] { padding-bottom: 4px; }
  summary {
    cursor: pointer;
    font-family: var(--label);
    font-size: 12.5px;
    color: var(--muted);
    list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸ "; color: var(--faint); }
  details[open] summary { margin-bottom: 10px; color: var(--text); }
  details[open] summary::before { content: "▾ "; }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

  /* ── What the report is honest about ─────────────────────────────── */

  /* The obvious treatment gives the green tick to Verified. The valuable
     list is the other one: an empty "not verified" is almost always a lie,
     so it gets the weight and the only second hue on the page, and what was
     checked is set quietly beneath it. */
  [data-bench="verified"] { color: var(--muted); font-size: 14px; }
  [data-bench="verified"] h2 { color: var(--faint); }
  [data-bench="verified"] code { font-size: 0.82em; }

  [data-bench="unverified"] {
    margin: 22px 0 0;
    padding: 2px 0 2px 16px;
    border-left: 2px solid var(--unverified);
  }
  [data-bench="unverified"] h2 {
    color: var(--unverified);
    border-bottom-color: rgba(224,177,85,0.28);
  }
  [data-bench="unverified"] li::marker { color: var(--unverified); }

  @media (max-width: 620px) {
    body { padding: 24px 18px 40px; font-size: 14.5px; }
    h1 { font-size: 23px; }
  }
`;

export function artifactPage(fragment: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${GROUND}</style></head><body>${fragment}</body></html>`;
}
