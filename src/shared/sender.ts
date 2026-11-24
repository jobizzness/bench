import type { MessageSender, ThreadEntryInput } from "./types.js";

/**
 * Who said a thread entry - one answer for the cockpit's label and the
 * agent's prompt header, so the two can never disagree.
 */

export const DEVELOPER: MessageSender = { kind: "developer" };
export const BENCH: MessageSender = { kind: "bench" };

/**
 * The sender of a `user` entry. Recorded on everything written since this
 * existed; older entries are read off their wording - the few shapes bench
 * itself ever wrote on someone else's behalf - and anything else is the
 * developer, which is what every one of them used to be shown as anyway.
 */
export function senderOf(entry: Pick<ThreadEntryInput, "kind" | "body" | "from">): MessageSender {
  if (entry.from) return entry.from;
  const body = entry.body;
  const report = /^([a-z0-9][a-z0-9-]*) wrote a report: "/i.exec(body);
  if (report) return { kind: "specialist", id: "", label: report[1] };
  const tab = /^From the ([A-Za-z0-9-]+) tab:/.exec(body);
  if (tab) return { kind: "specialist", id: "", label: tab[1] };
  if (/^\[bench\] (Context was cleared|Turn \d)/.test(body)) return BENCH;
  return DEVELOPER;
}

/** What the cockpit calls a sender. */
export function senderName(sender: MessageSender): string {
  if (sender.kind === "developer") return "you";
  if (sender.kind === "bench") return "bench";
  return sender.label;
}

/**
 * The line an agent reads first, saying who is talking and where its answer
 * goes. `opener` is the label of the specialist that opened the receiving
 * tab, when one did - the case agents got wrong, taking the developer's
 * words for their opener's and the other way round.
 */
export function promptHeader(
  sender: MessageSender,
  recipient: { opener: { id: string; label: string } | null; openedSender?: boolean },
): string {
  const { opener } = recipient;
  if (sender.kind === "bench") return "[from Bench]";
  if (sender.kind === "developer") {
    return opener
      ? `[from the developer, directly - not from ${opener.label}, the specialist that opened this tab. ${opener.label} is sent a note of it.]`
      : "[from the developer]";
  }
  if (opener && sender.id === opener.id) {
    return `[from ${sender.label}, the specialist that opened this tab. When this turn ends your answer goes back to ${sender.label} automatically - no need to bench tell it.]`;
  }
  // The other direction: one of this specialist's own tabs reporting back.
  if (recipient.openedSender) {
    return `[from ${sender.label}, a tab you opened - not the developer. This is it reporting back to you.]`;
  }
  return `[from ${sender.label}, another specialist on this project - not the developer]`;
}
