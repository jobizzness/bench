import { describe, it, expect } from "vitest";
import { parseEnvFile, envFilePaths, findCredentials, describeOrigin } from "../src/daemon/env-file.js";

/**
 * Bench finding its own credentials.
 *
 * Both keys were otherwise typed into Settings and held in memory, so every
 * daemon restart was the developer pasting the same two secrets again. A
 * `.env` they wrote is not a forgotten override; it is configuration.
 */

describe("reading a .env", () => {
  it("takes the plain form", () => {
    expect(parseEnvFile("ANTHROPIC_API_KEY=sk-ant-api03-abcd")).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-api03-abcd",
    });
  });

  it("ignores comments and blank lines", () => {
    const text = "# Required API keys\n\nGEMINI_API_KEY=sk-or-v1-abcd\n\n# trailing note\n";
    expect(parseEnvFile(text)).toEqual({ GEMINI_API_KEY: "sk-or-v1-abcd" });
  });

  it("reads a file written to be sourced as well as read", () => {
    // `export FOO=bar` is common enough that not taking it would look like
    // the file was ignored.
    expect(parseEnvFile("export GEMINI_API_KEY=sk-or-v1-abcd")).toEqual({
      GEMINI_API_KEY: "sk-or-v1-abcd",
    });
  });

  it("unwraps quotes, and keeps a hash that is inside them", () => {
    // A `#` in a quoted value is part of the key, not the start of a comment.
    // Trimming it would produce a credential that is silently wrong, which
    // reads as a key the API refuses.
    expect(parseEnvFile('A="sk-ant-with#hash"')).toEqual({ A: "sk-ant-with#hash" });
    expect(parseEnvFile("A='sk-ant-single'")).toEqual({ A: "sk-ant-single" });
  });

  it("drops a trailing comment from an unquoted value", () => {
    expect(parseEnvFile("A=sk-ant-abcd # the old one")).toEqual({ A: "sk-ant-abcd" });
  });

  it("skips a line it cannot make sense of rather than refusing the file", () => {
    // This file belongs to the developer and may hold anything. Refusing to
    // start over a line Bench does not care about is Bench making its problem
    // theirs.
    const text = "this is not an assignment\n9INVALID=x\nGOOD=yes\n=novalue\n";
    expect(parseEnvFile(text)).toEqual({ GOOD: "yes" });
  });

  it("treats an empty value as nothing said", () => {
    // `ANTHROPIC_API_KEY=` is a line someone commented out by deleting the
    // value. Reading it as a key would hand the CLI an empty credential.
    expect(parseEnvFile("ANTHROPIC_API_KEY=\nOTHER=x")).toEqual({ OTHER: "x" });
  });
});

describe("where it looks", () => {
  it("checks the daemon's home, then where it was started, then where it lives", () => {
    expect(envFilePaths({ home: "/home/dev/.bench", cwd: "/var/www/bench", installRoot: "/opt/bench" }))
      .toEqual(["/home/dev/.bench/.env", "/var/www/bench/.env", "/opt/bench/.env"]);
  });

  it("counts one directory once, however many ways it was named", () => {
    // Running the daemon from its own checkout is the ordinary case, and
    // listing that file twice would make the search look wider than it is.
    expect(envFilePaths({ home: "/h", cwd: "/var/www/bench", installRoot: "/var/www/bench" }))
      .toEqual(["/h/.env", "/var/www/bench/.env"]);
  });
});

describe("which key wins", () => {
  const files = (map: Record<string, Record<string, string>>) =>
    (path: string) => map[path] ?? null;

  it("finds both keys in a .env", () => {
    const found = findCredentials({
      home: "/h", cwd: "/w", env: {},
      read: files({ "/w/.env": { ANTHROPIC_API_KEY: "sk-ant-a", GEMINI_API_KEY: "sk-or-b" } }),
    });
    expect(found.anthropic!.key).toBe("sk-ant-a");
    expect(found.router!.key).toBe("sk-or-b");
  });

  it("takes the developer's own spelling of the OpenRouter name", () => {
    // OpenRouter's docs say OPENROUTER_API_KEY; OPEN_ROUTER_KEY is what was
    // actually in the file this was built for. A reader that refuses the
    // developer's spelling has not done what they asked.
    for (const name of ["GEMINI_API_KEY", "GEMINI_KEY", "GOOGLE_API_KEY", "GOOGLE_KEY"]) {
      const found = findCredentials({
        home: "/h", cwd: "/w", env: {},
        read: files({ "/w/.env": { [name]: "sk-or-b" } }),
      });
      expect(found.router!.key).toBe("sk-or-b");
    }
  });

  it("prefers a variable exported in the shell over one written in a file", () => {
    // How every other tool that reads a .env behaves: something exported
    // deliberately in this shell outranks something written down months ago.
    const found = findCredentials({
      home: "/h", cwd: "/w",
      env: { ANTHROPIC_API_KEY: "sk-ant-exported" },
      read: files({ "/w/.env": { ANTHROPIC_API_KEY: "sk-ant-written" } }),
    });
    expect(found.anthropic!.key).toBe("sk-ant-exported");
    expect(found.anthropic!.origin).toEqual({ from: "environment", name: "ANTHROPIC_API_KEY" });
  });

  it("prefers the daemon's own home to the directory it was started in", () => {
    const found = findCredentials({
      home: "/h", cwd: "/w", env: {},
      read: files({
        "/h/.env": { ANTHROPIC_API_KEY: "sk-ant-home" },
        "/w/.env": { ANTHROPIC_API_KEY: "sk-ant-cwd" },
      }),
    });
    expect(found.anthropic!.key).toBe("sk-ant-home");
  });

  it("says which file and which name, so a key can be accounted for", () => {
    // The last four characters identify a key only to someone who already
    // knows it. Where it came from is what lets them go and change it.
    const found = findCredentials({
      home: "/h", cwd: "/w", env: {},
      read: files({ "/w/.env": { GEMINI_KEY: "sk-or-b" } }),
    });
    expect(found.router!.origin).toEqual({
      from: "file", name: "GEMINI_KEY", path: "/w/.env",
    });
    expect(describeOrigin(found.router!.origin)).toBe("from GEMINI_KEY in /w/.env");
  });

  it("finds nothing rather than failing when there is no file anywhere", () => {
    const found = findCredentials({ home: "/h", cwd: "/w", env: {}, read: () => null });
    expect(found.anthropic).toBeNull();
    expect(found.router).toBeNull();
    expect(found.searched).toEqual(["/h/.env", "/w/.env"]);
  });

  it("leaves alone every other secret in the file", () => {
    // The daemon spreads its own environment into every specialist it spawns,
    // so merging a .env would hand an OpenAI key and a Gemini key to every
    // agent on the bench, to no purpose. Only the two Bench authenticates
    // with are taken out - the rest is not read into anything.
    const contents = {
      ANTHROPIC_API_KEY: "sk-ant-a",
      OPENAI_API_KEY: "sk-openai-should-not-travel",
      DEEPSEEK_API_KEY: "deepseek-should-not-travel",
    };
    const found = findCredentials({
      home: "/h", cwd: "/w", env: {}, read: files({ "/w/.env": contents }),
    });

    const taken = JSON.stringify(found);
    expect(taken).toContain("sk-ant-a");
    expect(taken).not.toContain("sk-openai-should-not-travel");
    expect(taken).not.toContain("deepseek-should-not-travel");
    expect(process.env.OPENAI_API_KEY).not.toBe("sk-openai-should-not-travel");
  });
});
