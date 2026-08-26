import { describe, it, expect } from "vitest";
import { windowsFrom, fetchUsage, machineToken, usageSource } from "../src/daemon/usage.js";
import { fullest, usageTone } from "../src/shared/usage.js";

/** The shape the endpoint answers in, as far as anything here cares: named
 * windows, each with how much of it is spent. */
const BODY = {
  five_hour: { utilization: 41, resets_at: "2026-08-25T14:20:00Z" },
  seven_day: { utilization: 68.4, resets_at: "2026-08-29T09:00:00Z" },
  seven_day_opus: { utilization: 22, resets_at: "2026-08-29T09:00:00Z" },
};

describe("reading the windows out of an answer", () => {
  it("keeps every window the API named, in the order it named them", () => {
    // Dynamic on purpose. A window the API adds next month should appear
    // without this file being edited - the alternative is a cockpit that
    // silently under-reports what a developer has spent.
    expect(windowsFrom(BODY).map((w) => w.key)).toEqual([
      "five_hour", "seven_day", "seven_day_opus",
    ]);
  });

  it("says a known window the short way", () => {
    expect(windowsFrom(BODY)[0].label).toBe("5-hour");
    expect(windowsFrom(BODY)[2].label).toBe("7-day Opus");
  });

  it("makes a readable label for a window it has never heard of", () => {
    const seen = windowsFrom({ seven_day_haiku_4_5: { utilization: 3 } });

    expect(seen[0].label).toBe("7-day haiku 4 5");
  });

  it("rounds a utilization to a whole percent", () => {
    expect(windowsFrom(BODY)[1].percent).toBe(68);
  });

  it("holds a percent inside the bar it is drawn in", () => {
    // Overage can carry a window past its limit. A bar is a hundred percent
    // wide and no wider; the number beside it still says what happened.
    expect(windowsFrom({ a: { utilization: 140 } })[0].percent).toBe(100);
    expect(windowsFrom({ a: { utilization: -2 } })[0].percent).toBe(0);
  });

  it("carries the reset time when there is one, and nothing when there is not", () => {
    expect(windowsFrom(BODY)[0].resetsAt).toBe("2026-08-25T14:20:00Z");
    expect(windowsFrom({ a: { utilization: 5 } })[0].resetsAt).toBe(null);
  });

  it("ignores anything in the answer that is not a window", () => {
    // The endpoint is free to send us account flags and strings. A window is
    // the thing with a number for how full it is.
    const seen = windowsFrom({ ...BODY, subscription: "max", overage: true, empty: {} });

    expect(seen.map((w) => w.key)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
  });

  it("finds no windows in an answer that is not an object at all", () => {
    expect(windowsFrom(null)).toEqual([]);
    expect(windowsFrom("nope")).toEqual([]);
  });
});

describe("asking the API what has been spent", () => {
  it("asks as the token, in the beta oauth is answered under", async () => {
    let url = "";
    let sent: Headers | undefined;
    const spy = (async (u: string, init: RequestInit) => {
      url = u;
      sent = new Headers(init.headers);
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchUsage("sk-ant-oat01-token", spy);

    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(sent?.get("authorization")).toBe("Bearer sk-ant-oat01-token");
    expect(sent?.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  it("answers with the windows it was given", async () => {
    const ok = (async () => new Response(JSON.stringify(BODY), { status: 200 })) as unknown as typeof fetch;

    const usage = await fetchUsage("sk-ant-oat01-token", ok);

    expect(usage.available).toBe(true);
    expect(usage.available && usage.windows).toHaveLength(3);
  });

  it("says the token was turned away rather than showing an empty panel", async () => {
    const no = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    expect(await fetchUsage("stale", no)).toEqual({ available: false, reason: "refused" });
  });

  it("says nothing could be reached when the machine is offline", async () => {
    const offline = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;

    expect(await fetchUsage("t", offline)).toEqual({ available: false, reason: "unreachable" });
  });

  it("treats an answer it cannot read as unreachable, not as nothing spent", async () => {
    const junk = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;

    expect(await fetchUsage("t", junk)).toEqual({ available: false, reason: "unreachable" });
  });
});

describe("the login this machine already has", () => {
  const FUTURE = 2000, PAST = 500;
  const file = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-machine", expiresAt: FUTURE, ...over } });

  it("uses the token the CLI stored, so a bench with no key of its own can still report", () => {
    expect(machineToken(() => file(), 1000)).toBe("sk-ant-oat01-machine");
  });

  it("will not use a token that has already expired", () => {
    // Refreshing is the CLI's job and its alone. An expired token here is a
    // 401 we can see coming, and a panel that says nothing beats one that
    // says the login is broken when it is not.
    expect(machineToken(() => file({ expiresAt: PAST }), 1000)).toBe(null);
  });

  it("uses a token that does not say when it expires", () => {
    expect(machineToken(() => file({ expiresAt: undefined }), 1000)).toBe("sk-ant-oat01-machine");
  });

  it("finds nothing when this machine has never logged in", () => {
    expect(machineToken(() => null, 1000)).toBe(null);
  });

  it("finds nothing in a credentials file it cannot make sense of", () => {
    expect(machineToken(() => "{ not json", 1000)).toBe(null);
    expect(machineToken(() => "{}", 1000)).toBe(null);
  });
});

describe("choosing the credential a usage panel is drawn from", () => {
  const OAT = "sk-ant-oat01-bench";
  const answered = (token: string[]) => (async (_u: string, init: RequestInit) => {
    token.push(String(new Headers(init.headers).get("authorization")));
    return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;

  it("asks as the bench's own token when it is holding one", async () => {
    const asked: string[] = [];
    const source = usageSource({ benchKey: () => OAT, machine: () => null, fetchImpl: answered(asked) });

    expect((await source()).available).toBe(true);
    expect(asked).toEqual([`Bearer ${OAT}`]);
  });

  it("falls back to this machine's login when the bench holds a console key", async () => {
    // An API key is billed, not rationed, and has no windows to report. The
    // specialists on a bench with no usable key are spending the machine's
    // login, so that is the login the panel should be about.
    const asked: string[] = [];
    const source = usageSource({
      benchKey: () => "sk-ant-api03-billed",
      machine: () => "sk-ant-oat01-machine",
      fetchImpl: answered(asked),
    });

    await source();

    expect(asked).toEqual(["Bearer sk-ant-oat01-machine"]);
  });

  it("has nothing to show when neither credential can be asked", async () => {
    const never = (async () => { throw new Error("should not be asked"); }) as unknown as typeof fetch;
    const source = usageSource({ benchKey: () => null, machine: () => null, fetchImpl: never });

    expect(await source()).toEqual({ available: false, reason: "none" });
  });

  it("does not ask again for a minute", async () => {
    // The panel opens on a hover, and a hover is cheap to repeat. The
    // endpoint should not be.
    const asked: string[] = [];
    let clock = 1_000;
    const source = usageSource({
      benchKey: () => OAT, machine: () => null, fetchImpl: answered(asked), now: () => clock,
    });

    await source();
    await source();
    clock += 59_000;
    await source();

    expect(asked).toHaveLength(1);
  });

  it("asks again once the answer is a minute old", async () => {
    const asked: string[] = [];
    let clock = 1_000;
    const source = usageSource({
      benchKey: () => OAT, machine: () => null, fetchImpl: answered(asked), now: () => clock,
    });

    await source();
    clock += 61_000;
    await source();

    expect(asked).toHaveLength(2);
  });

  it("asks again the moment the credential changes", async () => {
    // A key just saved should show its own usage, not the last one's.
    const asked: string[] = [];
    let held = OAT;
    const source = usageSource({ benchKey: () => held, machine: () => null, fetchImpl: answered(asked) });

    await source();
    held = "sk-ant-oat01-replaced";
    await source();

    expect(asked).toEqual([`Bearer ${OAT}`, "Bearer sk-ant-oat01-replaced"]);
  });

  it("does not keep a failure, so a fixed credential reports at once", async () => {
    let fail = true;
    const asked: string[] = [];
    const flaky = (async () => {
      if (fail) throw new Error("offline");
      asked.push("second");
      return new Response(JSON.stringify({ five_hour: { utilization: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = usageSource({ benchKey: () => OAT, machine: () => null, fetchImpl: flaky });

    expect(await source()).toEqual({ available: false, reason: "unreachable" });
    fail = false;

    expect((await source()).available).toBe(true);
  });
});

describe("the window that matters", () => {
  const window = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null });

  it("is the fullest one, wherever the API put it in the list", () => {
    expect(fullest([window("a", 12), window("b", 91), window("c", 40)])?.key).toBe("b");
  });

  it("is nothing at all when there are no windows", () => {
    expect(fullest([])).toBeNull();
  });

  it("goes to the first of a tie, which is the order the API named them in", () => {
    expect(fullest([window("a", 50), window("b", 50)])?.key).toBe("a");
  });
});

describe("how close is close enough to matter", () => {
  it("is chrome below three-quarters, a warning at it, and red near the end", () => {
    expect([usageTone(0), usageTone(74)]).toEqual(["ok", "ok"]);
    expect([usageTone(75), usageTone(89)]).toEqual(["high", "high"]);
    expect([usageTone(90), usageTone(100)]).toEqual(["full", "full"]);
  });
});
