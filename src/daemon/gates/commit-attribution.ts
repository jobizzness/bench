/**
 * Bans attribution, not the word "Claude". A commit that documents
 * CLAUDE.md is legitimate work; a commit that credits Claude as an author
 * is the thing being prevented. Matching trailers and footers rather than
 * keywords is what keeps this from becoming a nuisance filter.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /co-authored-by:\s*(claude|anthropic)/i,
  /generated\s+with\s+\[?claude/i,
  /🤖\s*generated\s+with/i,
  /\bauthored\s+by\s+claude\b/i,
];

const REASON =
  "Blocked: this commit message carries AI attribution. " +
  "Commits in this project must never credit Claude or Anthropic — " +
  "no Co-Authored-By trailer, no 'Generated with' footer. " +
  "Rewrite the message describing only what changed, then commit again.";

export function evaluateCommit(command: string): { deny: boolean; reason: string } {
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(command)) {
    return { deny: false, reason: "" };
  }

  for (const pattern of ATTRIBUTION_PATTERNS) {
    if (pattern.test(command)) return { deny: true, reason: REASON };
  }

  return { deny: false, reason: "" };
}
