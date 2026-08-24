import { LABEL_MAX } from "../shared/slug.js";

/**
 * Putting a second pair of eyes on a piece of work.
 *
 * Every report's Verified list is written by the agent that did the work. That
 * is honest and it is not review: an agent cannot find the thing it did not
 * think of, and it has already decided its own work is finished. A reviewer
 * opened here shares nothing with it but the repository - its own worktree,
 * its own conversation, and a brief that tells it to disagree.
 */

/**
 * What the reviewer is called. A label is a name a person reads now, so this
 * is one - the branch under it is slugged where branches are made.
 */
export function reviewLabel(label: string): string {
  const name = `Review of ${label.trim()}`;
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/**
 * What the reviewer is told.
 *
 * It names the branch and the report and then asks for disagreement, because
 * "review this" gets a summary back. The instruction to say when it found
 * nothing matters as much as the rest: a reviewer that always finds three
 * things is a reviewer nobody can act on.
 */
export function reviewBrief(opts: {
  label: string;
  branch: string;
  reportPath: string | null;
}): string {
  const lines = [
    `You are reviewing work done by another specialist on this project, on the`,
    `branch \`${opts.branch}\` (its tab is called "${opts.label}"). You are in your`,
    `own worktree on your own branch - read that one, do not change it.`,
    ``,
    `Start with what actually changed:`,
    ``,
    "```",
    `git diff main...${opts.branch}`,
    `git log --oneline main..${opts.branch}`,
    "```",
  ];

  if (opts.reportPath) {
    lines.push(
      ``,
      `What it claims to have done is in ${opts.reportPath}. Read it after the`,
      `diff rather than before, so the code tells you what it does before its`,
      `author does.`,
    );
  }

  lines.push(
    ``,
    `Your job is to disagree with it, specifically. Not to summarise it, and`,
    `not to approve it. Look for:`,
    ``,
    `- claims in its Verified list that the diff does not support`,
    `- what it says it did not verify, and whether any of that is load-bearing`,
    `- behaviour it changed without saying so`,
    `- the case it did not think of: empty, concurrent, offline, already-there`,
    `- tests that assert the implementation rather than the behaviour`,
    ``,
    `Run whatever proves or disproves a suspicion. You have the same shell it`,
    `had.`,
    ``,
    `Then report. Each finding: what is wrong, the file and line, and how you`,
    `know - a command and its output beats an assertion. Rank them, because the`,
    `developer will act on the first two and skim the rest.`,
    ``,
    `If you find nothing worth their time, say that plainly and stop. A review`,
    `that always finds three things is a review nobody can act on.`,
  );

  return lines.join("\n");
}
