import { useEffect, useRef } from "react";
import { relativeTime } from "../format.js";
import { GithubMark } from "./GithubMark.js";
import type { GithubItem, GithubList } from "./useGithub.js";

/** Open, merged, closed, draft. The state is the first thing worth knowing
 * about a line, so it is a word rather than a colour alone. */
function stateOf(item: GithubItem): string {
  if (item.kind === "pull" && item.draft && item.state === "open") return "draft";
  return item.state;
}

function Row({ item }: { item: GithubItem }) {
  return (
    <a
      className="gh-row"
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      data-kind={item.kind}
      data-state={stateOf(item)}
    >
      <span className="gh-number">#{item.number}</span>
      <span className="gh-title">{item.title}</span>
      <span className="gh-meta">
        <span className="gh-state">{stateOf(item)}</span>
        {item.author && <span className="gh-author">{item.author}</span>}
        <span className="gh-when">{relativeTime(item.updatedAt)}</span>
      </span>
    </a>
  );
}

/**
 * What has been happening on the project this specialist works in.
 *
 * A drawer rather than a page: it is something you glance at beside the work
 * and then push away again, and it never needs the whole screen. Sorted by
 * when each last moved, because a two-week-old issue commented on this
 * morning is the one being looked for.
 */
export function GithubDrawer({
  open, list, project, onClose,
}: {
  open: boolean;
  list: GithubList;
  /** The project the specialist lives in, for when GitHub knows nothing. */
  project: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) { if (!dialog.open) dialog.showModal?.(); }
    else if (dialog.open) dialog.close?.();
  }, [open]);

  const issues = list.items.filter((i) => i.kind === "issue");
  const pulls = list.items.filter((i) => i.kind === "pull");

  return (
    <dialog
      id="gh-drawer"
      className="drawer"
      ref={ref}
      onClose={onClose}
      // A click on the scrim reports the dialog itself as its target, since
      // the backdrop is drawn by the dialog rather than by an element of its
      // own. Anything inside it targets that instead - so this is the whole
      // of "click outside to close", and it is safe here because the drawer
      // holds nothing you could be halfway through.
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <header id="gh-head">
        <GithubMark size={15} />
        <span id="gh-slug">{list.slug ?? "no GitHub remote"}</span>
        <button type="button" id="gh-close" aria-label="Close" onClick={onClose}>×</button>
      </header>

      {list.loading && list.items.length === 0 && <p className="gh-note">Asking GitHub…</p>}

      {!list.loading && list.items.length === 0 && (
        <p className="gh-note">
          {list.slug
            ? "Nothing open or recently touched."
            : `${project ?? "This project"} has no GitHub remote, so there is nothing to list.`}
        </p>
      )}

      {list.items.length > 0 && (
        <div id="gh-list">
          {pulls.length > 0 && (
            <>
              <h3 className="eyebrow">{pulls.length} pull {pulls.length === 1 ? "request" : "requests"}</h3>
              {pulls.map((item) => <Row key={`pr-${item.number}`} item={item} />)}
            </>
          )}
          {issues.length > 0 && (
            <>
              <h3 className="eyebrow">{issues.length} {issues.length === 1 ? "issue" : "issues"}</h3>
              {issues.map((item) => <Row key={`is-${item.number}`} item={item} />)}
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
