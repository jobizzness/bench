/**
 * The page an agent's fragment is rendered into.
 *
 * The skills ask for a fragment - no html, head or body - and nothing ever
 * supplied the rest. A fragment with no styles rendered as black on the
 * cockpit's dark ground, and one written in light-mode colours rendered as
 * near-black on it, which is what "the report has no styles" looks like.
 *
 * The frame owns the ground: background, text colour, and sensible defaults
 * for the elements a report is made of. Anything the agent sets wins, because
 * its own styles come later in the cascade.
 */
const GROUND = `
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #16211c; color: #e8efe9; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    padding: 20px 22px 28px;
  }
  h1, h2, h3, h4 { color: #f2f7f3; line-height: 1.25; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.05rem; margin: 1.4rem 0 .4rem; }
  a { color: #4fd18b; }
  code, pre { font-family: ui-monospace, monospace; }
  code { background: rgba(255,255,255,0.06); padding: .1em .35em; border-radius: 3px; }
  pre { background: rgba(255,255,255,0.04); padding: 12px 14px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: .45rem .6rem .45rem 0; text-align: left; }
  blockquote { margin: 0 0 1rem; padding-left: 12px; border-left: 2px solid rgba(255,255,255,0.14); color: #8ba396; }
  hr { border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 1.2rem 0; }
  img { max-width: 100%; }
`;

export function artifactPage(fragment: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${GROUND}</style></head><body>${fragment}</body></html>`;
}
