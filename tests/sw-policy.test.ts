import { describe, it, expect } from "vitest";
import { handling, isShellPath, SHELL_ASSETS } from "../src/client/sw-policy.js";

const asked = (over: Partial<Parameters<typeof handling>[0]> = {}) =>
  handling({ method: "GET", mode: "no-cors", sameOrigin: true, pathname: "/app.js", ...over });

describe("what the service worker will answer", () => {
  it("keeps the shell's own files", () => {
    for (const path of SHELL_ASSETS) expect(asked({ pathname: path })).toBe("asset");
  });

  it("keeps the document, at the root and at a specialist's URL", () => {
    expect(asked({ mode: "navigate", pathname: "/" })).toBe("page");
    expect(asked({ mode: "navigate", pathname: "/s/9f1c2b3a" })).toBe("page");
  });

  it("never touches live state", () => {
    // The whole reason the worker exists is to survive the daemon being
    // restarted. Serving a decision from before that restart would be worse
    // than a broken page: it is a question that has already been answered.
    expect(asked({ pathname: "/api/roster" })).toBe("pass");
    expect(asked({ pathname: "/api/sessions/s1/thread" })).toBe("pass");
    expect(asked({ pathname: "/events" })).toBe("pass");
  });

  it("never caches the manifest, which carries the token", () => {
    // A cache outlives the daemon that issued the token in it.
    expect(asked({ pathname: "/manifest.webmanifest" })).toBe("pass");
  });

  it("leaves reports to the daemon, cached or not", () => {
    expect(asked({ mode: "navigate", pathname: "/r/s1/2/report.html" })).toBe("pass");
    expect(asked({ pathname: "/r/s1/2/report.html" })).toBe("pass");
  });

  it("stands aside for anything that is not a plain read", () => {
    expect(asked({ method: "POST", pathname: "/api/sessions/s1/message" })).toBe("pass");
    expect(asked({ method: "POST", mode: "navigate", pathname: "/" })).toBe("pass");
  });

  it("stands aside for another origin entirely", () => {
    expect(asked({ sameOrigin: false, pathname: "/app.js" })).toBe("pass");
  });

  it("knows a specialist's URL from something merely under /s/", () => {
    expect(isShellPath("/s/abc")).toBe(true);
    expect(isShellPath("/s/abc/")).toBe(true);
    expect(isShellPath("/s/abc/extra")).toBe(false);
    expect(isShellPath("/style.css")).toBe(false);
  });
});
