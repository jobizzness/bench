import { useEffect, useRef } from "react";
import { renderMarkdown } from "../markdown.js";

/**
 * Specialists write markdown. Showing its punctuation instead of its shape
 * made every reply harder to read than the transcript it exists to replace.
 *
 * The renderer builds nodes rather than a string, which is what keeps it
 * safe from anything a specialist writes — so this hands React an empty box
 * and fills it, instead of reaching for dangerouslySetInnerHTML.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    host.current?.replaceChildren(renderMarkdown(text));
  }, [text]);

  return <div className={className} ref={host} />;
}
