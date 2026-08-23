import { useEffect, useRef } from "react";
import { renderMarkdown, type References } from "../markdown.js";

/**
 * Specialists write markdown. Showing its punctuation instead of its shape
 * made every reply harder to read than the transcript it exists to replace.
 *
 * The renderer builds nodes rather than a string, which is what keeps it
 * safe from anything a specialist writes — so this hands React an empty box
 * and fills it, instead of reaching for dangerouslySetInnerHTML.
 */
export function Markdown({ text, className, refs }: {
  text: string;
  className?: string;
  /** What the #numbers in the text are about, where anyone knows. */
  refs?: References;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    host.current?.replaceChildren(renderMarkdown(text, refs));
  }, [text, refs]);

  return <div className={className} ref={host} />;
}
