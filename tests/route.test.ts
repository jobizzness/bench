import { describe, it, expect } from "vitest";
import { sessionFromPath, pathForSession } from "../src/client/route.js";

describe("sessionFromPath", () => {
  it("reads the session out of the path", () => {
    expect(sessionFromPath("/s/89c0812e-ff63-4918-a200-59c393d72fdd"))
      .toBe("89c0812e-ff63-4918-a200-59c393d72fdd");
  });

  it("tolerates a trailing slash", () => {
    expect(sessionFromPath("/s/abc/")).toBe("abc");
  });

  it("is nothing at the root", () => {
    expect(sessionFromPath("/")).toBeNull();
  });

  it("is nothing for a path that only looks close", () => {
    expect(sessionFromPath("/s/")).toBeNull();
    expect(sessionFromPath("/s/a/b")).toBeNull();
    expect(sessionFromPath("/session/abc")).toBeNull();
  });

  it("refuses anything that is not an id", () => {
    // The value is used to select a session, never to build a path.
    expect(sessionFromPath("/s/../../etc/passwd")).toBeNull();
    expect(sessionFromPath("/s/a b")).toBeNull();
  });
});

describe("pathForSession", () => {
  it("keeps the token, which navigation would otherwise drop", () => {
    expect(pathForSession("abc", "?token=xyz")).toBe("/s/abc?token=xyz");
  });

  it("goes back to the root when nothing is selected", () => {
    expect(pathForSession(null, "?token=xyz")).toBe("/?token=xyz");
  });

  it("copes with no query string at all", () => {
    expect(pathForSession("abc", "")).toBe("/s/abc");
  });
});
