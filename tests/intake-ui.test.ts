/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionSchema } from "../src/shared/types.js";

/**
 * Drives the real cockpit script in a DOM rather than testing a copy of its
 * logic. The intake is the one part of Bench the developer touches with a
 * mouse, so "it parses" is not evidence that it works.
 */

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client");

const INTAKE = decisionSchema.parse({
  kind: "intake",
  title: "Password reset — before I build",
  summary: "Four questions. Two I could not guess.",
  brief: "Links expire after {expiry}, cover {flows}, and requests are {ratelimit}.",
  questions: [
    {
      id: "expiry",
      ask: "How long should a reset token live?",
      why: "Sets the email copy.",
      options: [
        { id: "15m", label: "15 minutes", hint: "Matches the login OTP." },
        { id: "1h", label: "1 hour", default: true },
      ],
    },
    {
      id: "flows",
      ask: "Which entry points get it?",
      select: "many",
      options: [
        { id: "web", label: "Web", default: true },
        { id: "mobile", label: "Mobile" },
      ],
    },
    {
      // No default anywhere: the specialist genuinely cannot guess this one.
      id: "audit",
      ask: "Log resets to the audit trail?",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    },
    {
      id: "ratelimit",
      ask: "Rate limit the endpoint?",
      stakes: "low",
      options: [{ id: "reuse", label: "the existing limiter", default: true }],
    },
  ],
});

const ROW = {
  id: "s1", label: "reset", project: "/var/www/demo",
  status: "awaiting_decision", detail: "ready",
  latestReportSeq: 1, startedAt: null, tokens: 0,
};

let sent: Array<{ url: string; body: any }> = [];
let socket: any;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const $$ = (selector: string) => [...document.querySelectorAll(selector)];
// A tick was enough while every screen rendered synchronously. React
// islands mount and flush across scheduler turns, so waits are given room.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The composer's live send button, which doubles as the state readout. */
const send = () => $<HTMLButtonElement>("#composer-send");
const questionCards = () => $$("#intake-questions .question") as HTMLElement[];

// Found by what they ask, not by position: the panel deliberately reorders,
// and an index here would only be asserting the fixture back at itself.
const ASKS: Record<string, string> = {
  expiry: "How long should a reset token live?",
  flows: "Which entry points get it?",
  audit: "Log resets to the audit trail?",
};
const cardFor = (id: string) =>
  questionCards().find((c) => c.querySelector(".q-ask")!.textContent === ASKS[id])!;
const optionsIn = (card: HTMLElement) =>
  [...card.querySelectorAll("button.option")] as HTMLButtonElement[];
const optionsFor = (id: string) => optionsIn(cardFor(id));
const pressedIn = (id: string) => optionsFor(id).map((b) => b.getAttribute("aria-pressed"));

beforeAll(async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  document.body.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");

  class FakeSocket {
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { socket = this; }
    send() {}
    close() {}
  }
  (globalThis as any).WebSocket = FakeSocket;

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.includes("/thread")) {
      return { ok: true, json: async () => ({ entries: [{ seq: 1, at: new Date().toISOString(), kind: "user", body: "add password reset" }] }) };
    }
    if (url.includes("/report/1")) {
      return { ok: true, json: async () => ({ seq: 1, decision: INTAKE, malformed: false }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  // main mounts the React islands as well as running the vanilla cockpit.
  await import("../src/client/main.tsx");
  await settle();

  socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [ROW] }) });
  await settle();
  $<HTMLElement>("#roster-list .row").click();
  await settle();
  await settle();
});

describe("an answered decision", () => {
  it("leaves the screen once it has been answered", async () => {
    // Answering is the whole interaction. The row still says it is waiting
    // on you with the same latest report, so only the answered seq can tell
    // the difference between a question and one already dealt with.
    socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [
      { ...ROW, latestReportSeq: 1, answeredReportSeq: 1 },
    ] }) });
    await settle();
    await settle();

    expect($<HTMLElement>("#decision").hidden).toBe(true);

    // Put it back for the suites that follow.
    socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [ROW] }) });
    await settle();
    await settle();
  });
});

describe("the progress panel beside an intake", () => {
  it("gets out of the way while a decision is waiting", async () => {
    // A decision means the turn ended, so a checklist above it is stale by
    // definition - and it sits directly above the question being asked.
    socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [{
      ...ROW,
      activity: [{ at: new Date().toISOString(), text: "Edit src/client/app.js" }],
    }] }) });
    // The panel is repainted on the cockpit's own interval, not on the event.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect($<HTMLElement>("#progress").hidden).toBe(true);
  });
});

describe("the intake panel", () => {
  it("shows every question the specialist could not fold away, at once", () => {
    expect($("#intake").hasAttribute("hidden")).toBe(false);
    // ratelimit is low-stakes and answered, so it folds; the other three do not.
    expect(questionCards()).toHaveLength(3);
    expect($("#intake-assumed").hasAttribute("hidden")).toBe(false);
    expect($("#intake-assumed-count").textContent).toBe("1 more I've already assumed");
    expect($("#intake-assumed-preview").textContent).toBe("the existing limiter");
  });

  it("leads with the question the specialist could not guess", () => {
    // The panel scrolls, so the only question that blocks sending has to be
    // on the first screen rather than under the fold.
    expect(questionCards().map((c) => c.querySelector(".q-ask")!.textContent))
      .toEqual([ASKS.audit, ASKS.expiry, ASKS.flows]);
  });

  it("hides the old single-option row so the two never render together", () => {
    expect($("#decision-options").hasAttribute("hidden")).toBe(true);
  });

  it("pre-selects the specialist's own picks and labels them as its own", () => {
    const [fifteen, hour] = optionsFor("expiry");
    expect(hour.getAttribute("aria-pressed")).toBe("true");
    expect(fifteen.getAttribute("aria-pressed")).toBe("false");
    expect(hour.textContent).toContain("mine");
    expect(fifteen.textContent).not.toContain("mine");
  });

  it("marks a question with no default as the one still needing the developer", () => {
    expect(cardFor("audit").dataset.state).toBe("open");
    expect(cardFor("audit").textContent).toContain("needs you");
    expect(cardFor("expiry").dataset.state).toBe("assumed");
  });

  it("refuses to send while an unguessable question is unanswered, and says how many", () => {
    expect(send().disabled).toBe(true);
    expect(send().textContent).toBe("1 still needs you");
  });

  it("fills the brief's holes from the current answers", () => {
    const slots = $$("#intake-brief .slot").map((s) => s.textContent);
    expect(slots).toEqual(["1 hour", "Web", "the existing limiter"]);
    expect($("#intake-brief").textContent)
      .toBe("Links expire after 1 hour, cover Web, and requests are the existing limiter.");
  });
});

describe("answering it", () => {
  it("rewrites the brief as an option is chosen", async () => {
    optionsFor("expiry")[0].click();
    await settle();
    expect($("#intake-brief").textContent).toContain("expire after 15 minutes");
    expect($$("#intake-brief .slot")[0].getAttribute("data-state")).toBe("changed");
  });

  it("adds rather than replaces on a multi-select question", async () => {
    optionsFor("flows")[1].click();
    await settle();
    expect(pressedIn("flows")).toEqual(["true", "true"]);
    expect($("#intake-brief").textContent).toContain("cover Web and Mobile");
  });

  it("replaces rather than adds on a single-select question", () => {
    expect(pressedIn("expiry")).toEqual(["true", "false"]);
  });

  it("does not reshuffle the questions as they are answered", () => {
    // The order is fixed by what the specialist guessed, not by what you
    // have done since - a list that reorders under the cursor is unreadable.
    expect(questionCards().map((c) => c.querySelector(".q-ask")!.textContent))
      .toEqual([ASKS.audit, ASKS.expiry, ASKS.flows]);
  });

  it("unblocks the send bar once the last open question is answered", async () => {
    optionsFor("audit")[0].click();
    await settle();
    expect(send().disabled).toBe(false);
    expect(send().textContent).toBe("Send 4 answers · 3 yours");
  });

  it("posts every answer in the order the specialist asked them", async () => {
    sent = [];
    $<HTMLInputElement>("#composer-text").value = "keep the copy terse";
    $("#composer-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
    await settle();

    const post = sent.find((s) => s.url.includes("/answer"))!;
    expect(post.body.text).toBe("keep the copy terse");
    // Display order is the developer's; the reply keeps the agent's own.
    expect(post.body.answers).toEqual([
      { questionId: "expiry", ask: ASKS.expiry, labels: ["15 minutes"], text: "", defaulted: false },
      { questionId: "flows", ask: ASKS.flows, labels: ["Web", "Mobile"], text: "", defaulted: false },
      { questionId: "audit", ask: ASKS.audit, labels: ["Yes"], text: "", defaulted: false },
      // Never opened, never touched - and it says so.
      { questionId: "ratelimit", ask: "Rate limit the endpoint?", labels: ["the existing limiter"], text: "", defaulted: true },
    ]);
  });
});

const key = async (k: string) => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle();
};

/** A fresh intake: submitting cleared the last one. */
const reopen = async () => {
  socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [ROW] }) });
  await settle();
  await settle();
};

describe("driving it from the keyboard", () => {
  it("starts focused on what blocks, and shows keycaps only there", async () => {
    await reopen();
    expect(cardFor("audit").dataset.focused).toBe("true");
    expect(optionsFor("audit")[0].querySelector(".key")?.textContent).toBe("1");
    // A key that would do nothing is a promise the app breaks.
    expect(optionsFor("expiry")[0].querySelector(".key")).toBeNull();
  });

  it("refuses Enter while that question is unanswered", async () => {
    sent = [];
    await key("Enter");
    expect(sent.some((s) => s.url.includes("/answer"))).toBe(false);
    expect(cardFor("audit").dataset.focused).toBe("true");
    expect(cardFor("audit").dataset.state).toBe("open");
  });

  it("picks within the focused question by number", async () => {
    await key("1");
    expect(pressedIn("audit")).toEqual(["true", "false"]);
    expect(send().disabled).toBe(false);
    expect(send().textContent).toBe("Send 4 answers · 1 yours");
  });

  it("moves focus with the arrows and retargets the number keys", async () => {
    await key("ArrowDown");
    expect(cardFor("expiry").dataset.focused).toBe("true");
    await key("1");
    expect(pressedIn("expiry")).toEqual(["true", "false"]);
  });

  it("ignores keys while the developer is typing an answer in their own words", async () => {
    const field = cardFor("expiry").querySelector("input.q-text") as HTMLInputElement;
    field.value = "however long the OTP lives";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
    await settle();
    // The "2" landed in the field, not on option two.
    expect(pressedIn("expiry")).toEqual(["true", "false"]);
  });

  it("keeps a half-given answer across a roster tick", async () => {
    // The roster pushes constantly. Reloading the decision on every push used
    // to throw away whatever had been chosen since the last one.
    await reopen();
    expect(pressedIn("audit")).toEqual(["true", "false"]);
    expect(cardFor("expiry").querySelector<HTMLInputElement>("input.q-text")!.value)
      .toBe("however long the OTP lives");
  });

  it("sends on Enter once nothing is outstanding", async () => {
    sent = [];
    await key("Enter");
    const post = sent.find((s) => s.url.includes("/answer"));
    expect(post).toBeDefined();
    expect(post!.body.answers).toHaveLength(4);
    expect(post!.body.answers[0].text).toBe("however long the OTP lives");
    expect(post!.body.answers[0].labels).toEqual(["15 minutes"]);
  });
});
