/**
 * What a specialist receives when a report is shared with it.
 *
 * The report is a file on disk and every specialist has a shell, so the
 * useful thing to hand over is the path - not a summary of the page, which
 * would be Bench paraphrasing an artifact it did not write. The recipient
 * reads the original.
 *
 * It arrives as an ordinary prompt and takes an ordinary turn. Sharing is
 * asking someone to look at something, which is work, and pretending it is
 * free would only hide what it cost.
 */
export function shareMessage(opts: {
  from: string;
  title: string;
  path: string;
  note?: string;
}): string {
  const lines = [
    `${opts.from} wrote a report the developer wants you to read: "${opts.title}".`,
    "",
    `It is at ${opts.path} — read it there rather than asking for a summary.`,
  ];

  const note = opts.note?.trim();
  if (note) lines.push("", note);

  lines.push(
    "",
    "You are not being asked to act on it yet. Say what it changes for what "
    + "you are doing, or say that it changes nothing.",
  );

  return lines.join("\n");
}
