/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { answersFor } from "../src/shared/decisions.js";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * When an agent asks for a plan to be approved, the options it writes are the
 * forks inside the plan. None of them is the answer the developer most often
 * wants to give, which is yes build it, or no do not.
 */

const spec = (options: Decision["options"] = []): Decision => ({
  kind: "spec_approval",
  title: "Token expiry for password reset",
  summary: "Single-use tokens work; the window is your call.",
  options,
  questions: [],
  allowFreeText: true,
});

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const labels = () => ui.$$(".option .label").map((n) => n.textContent);

async function open(decision: Decision): Promise<void> {
  ui = await bootCockpit({
    rows: [row({ label: "reset", latestReportSeq: 1, answeredReportSeq: null })],
    decision,
  });
  await ui.open("reset");
  await waitFor(() => ui.$(".option"), "the decision");
}

describe("a spec always has the two answers that matter", () => {
  it("offers approve and reject first, even when the agent wrote nothing", () => {
    expect(answersFor(spec()).map((o) => o.id)).toEqual(["approved", "rejected"]);
  });

  it("keeps the agent's own forks after them", () => {
    // A spec can be approved and have a fork settled in one answer.
    expect(answersFor(spec([{ id: "15m", label: "15 minutes" }])).map((o) => o.id))
      .toEqual(["approved", "rejected", "15m"]);
  });

  it("leaves every other kind of decision alone", () => {
    const done: Decision = { ...spec([{ id: "ship", label: "Merge it" }]), kind: "completion" };
    expect(answersFor(done).map((o) => o.id)).toEqual(["ship"]);
  });

  it("draws them on the decision itself", async () => {
    await open(spec([{ id: "15m", label: "15 minutes" }]));
    expect(labels()).toEqual(["Approve", "Reject", "15 minutes"]);
  });

  it("sends the one that was pressed", async () => {
    await open(spec());
    await ui.click(ui.$$(".option")[1]);
    await ui.pressIn(ui.$("#composer-text"), "Enter");

    const sent = ui.sent.find((s) => s.url.includes("/answer"))!;
    expect(sent.body.optionId).toBe("rejected");
  });

  it("numbers them the way they are drawn", async () => {
    // 1 must be Approve, or the keycaps say one thing and do another.
    await open(spec([{ id: "15m", label: "15 minutes" }]));
    await ui.press("1");

    expect(ui.$$(".option")[0].getAttribute("aria-pressed")).toBe("true");
  });
});
