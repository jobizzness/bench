import { describe, it, expect } from "vitest";
import { tokenPath, eventsUrl, apiBase } from "../editor/vscode/src/endpoint.js";
import { insideWorkspace } from "../editor/vscode/src/inside.js";

/**
 * The two decisions the extension makes before it touches the VS Code API:
 * where its daemon is, and whether a path is any of its business. Both are
 * pure, so both are tested here rather than by hand in a second editor.
 */
describe("finding the daemon", () => {
  it("looks in ~/.bench when nothing says otherwise", () => {
    expect(tokenPath({}, "/home/dev")).toBe("/home/dev/.bench/token");
  });

  it("follows BENCH_HOME, so a second daemon is reachable", () => {
    expect(tokenPath({ BENCH_HOME: "/tmp/other" }, "/home/dev")).toBe("/tmp/other/token");
  });

  /** `as=editor` is how the daemon tells an editor from a cockpit on the
   * one socket, so it knows who to send a target to (#129). */
  it("uses the default port, and says what it is", () => {
    expect(eventsUrl({}, "abc")).toBe("ws://127.0.0.1:7420/events?token=abc&as=editor");
  });

  it("follows BENCH_PORT", () => {
    expect(eventsUrl({ BENCH_PORT: "9001" }, "abc"))
      .toBe("ws://127.0.0.1:9001/events?token=abc&as=editor");
  });

  it("escapes a token that would otherwise break the query string", () => {
    expect(eventsUrl({}, "a b&c")).toBe("ws://127.0.0.1:7420/events?token=a%20b%26c&as=editor");
  });

  /**
   * Loopback is not a preference. The token is the whole of the daemon's
   * authentication and reaching that port is reaching a shell, so the
   * extension never talks to anything but this machine.
   */
  it("always talks to loopback, whatever the environment says", () => {
    expect(eventsUrl({ BENCH_HOST: "0.0.0.0" } as Record<string, string>, "abc"))
      .toBe("ws://127.0.0.1:7420/events?token=abc&as=editor");
  });
});

describe("deciding whether a path is ours to open", () => {
  it("takes a file inside an open folder", () => {
    expect(insideWorkspace("/var/www/bench/src/daemon/registry.ts", ["/var/www/bench"])).toBe(true);
  });

  /**
   * The case that makes the whole feature work: a worktree lives at
   * `<repo>/.claude/worktrees/<name>`, which is already inside the folder the
   * developer has open. No second window, no folder to add.
   */
  it("takes a file in a specialist's worktree, because that is inside the repo", () => {
    expect(insideWorkspace(
      "/var/www/bench/.claude/worktrees/auth-abcd1234/src/daemon/registry.ts",
      ["/var/www/bench"],
    )).toBe(true);
  });

  it("refuses a file in a project this window does not have open", () => {
    expect(insideWorkspace("/var/www/other/src/x.ts", ["/var/www/bench"])).toBe(false);
  });

  /**
   * A prefix match on the string would take this, and the developer would
   * watch an unrelated checkout's files open in the wrong window.
   */
  it("refuses a sibling directory that merely starts with the same name", () => {
    expect(insideWorkspace("/var/www/bench-old/src/x.ts", ["/var/www/bench"])).toBe(false);
  });

  it("takes the folder itself", () => {
    expect(insideWorkspace("/var/www/bench", ["/var/www/bench"])).toBe(true);
  });

  it("checks every open folder, not only the first", () => {
    expect(insideWorkspace("/var/www/other/x.ts", ["/var/www/bench", "/var/www/other"])).toBe(true);
  });

  it("refuses everything when no folder is open", () => {
    expect(insideWorkspace("/var/www/bench/src/x.ts", [])).toBe(false);
  });

  it("tolerates a trailing slash on a workspace folder", () => {
    expect(insideWorkspace("/var/www/bench/src/x.ts", ["/var/www/bench/"])).toBe(true);
  });

  it("refuses a relative path, having nothing to resolve it against", () => {
    expect(insideWorkspace("src/x.ts", ["/var/www/bench"])).toBe(false);
  });
});

describe("reaching the daemon's HTTP routes", () => {
  it("uses the same port as the socket", () => {
    expect(apiBase({})).toBe("http://127.0.0.1:7420");
    expect(apiBase({ BENCH_PORT: "9001" })).toBe("http://127.0.0.1:9001");
  });

  it("stays on loopback, like the socket does", () => {
    expect(apiBase({ BENCH_HOST: "0.0.0.0" } as Record<string, string>))
      .toBe("http://127.0.0.1:7420");
  });
});
