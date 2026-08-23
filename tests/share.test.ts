import { describe, it, expect } from "vitest";
import { shareMessage } from "../src/daemon/share.js";

const base = {
  from: "bank-payments",
  title: "Bank payments spec — four tickets, PWA only",
  path: "/var/www/fulacx/.bench/reports/71c543da/2/report.html",
};

describe("shareMessage", () => {
  it("names who wrote it and what it is called", () => {
    const message = shareMessage(base);
    expect(message).toContain("bank-payments");
    expect(message).toContain("Bank payments spec");
  });

  it("hands over the path rather than a summary", () => {
    // Bench paraphrasing an artifact it did not write is how a recipient
    // ends up acting on something nobody checked.
    const message = shareMessage(base);
    expect(message).toContain(base.path);
    expect(message).toMatch(/read it there/i);
  });

  it("says what is being asked, which is not action", () => {
    const message = shareMessage(base);
    expect(message).toMatch(/not being asked to act/i);
  });

  it("carries a note when the developer wrote one", () => {
    const message = shareMessage({ ...base, note: "The rate limit affects your queue." });
    expect(message).toContain("The rate limit affects your queue.");
  });

  it("leaves no empty gap when there is no note", () => {
    expect(shareMessage(base)).not.toMatch(/\n\n\n/);
  });

  it("ignores a note that is only whitespace", () => {
    expect(shareMessage({ ...base, note: "   \n  " })).toEqual(shareMessage(base));
  });
});
