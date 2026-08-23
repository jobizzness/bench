import { describe, it, expect } from "vitest";
import { parseSlug, RefIndex, type Ref } from "../src/daemon/refs.js";

describe("which repository a number belongs to", () => {
  it("reads both spellings of a GitHub remote", () => {
    expect(parseSlug("git@github.com:jobizzness/bench.git\n")).toBe("jobizzness/bench");
    expect(parseSlug("https://github.com/jobizzness/bench.git")).toBe("jobizzness/bench");
    expect(parseSlug("https://github.com/jobizzness/bench")).toBe("jobizzness/bench");
  });

  it("declines anything that is not GitHub", () => {
    // Bench does not know what #12 means on a self-hosted forge, and a wrong
    // link is worse than a plain number.
    expect(parseSlug("git@gitlab.com:someone/thing.git")).toBeNull();
    expect(parseSlug("/var/www/local-only")).toBeNull();
  });
});

const ref = (number: number): Ref => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  kind: "issue",
});

/** Counts what it was asked, so the cache can be seen working. */
function probe(now: () => number = () => 0) {
  const asked: number[] = [];
  const index = new RefIndex({
    readSlug: async () => "o/r",
    resolve: async (_slug, n) => { asked.push(n); return n === 404 ? null : ref(n); },
    now,
  });
  return { index, asked };
}

describe("resolving what a thread mentions", () => {
  it("returns the title and the link for a number that exists", async () => {
    const { index } = probe();
    expect(await index.lookup("/p", [12])).toEqual([ref(12)]);
  });

  it("says nothing at all about a project with no GitHub remote", async () => {
    const index = new RefIndex({ readSlug: async () => null, resolve: async (_s, n) => ref(n) });
    expect(await index.lookup("/tmp/not-a-repo", [12])).toEqual([]);
  });

  it("drops a number nobody could resolve rather than inventing one", async () => {
    const { index } = probe();
    expect(await index.lookup("/p", [12, 404])).toEqual([ref(12)]);
  });

  it("ignores rubbish in the query", async () => {
    const { index, asked } = probe();
    await index.lookup("/p", [0, -3, 1.5, NaN]);
    expect(asked).toEqual([]);
  });
});

describe("the cache", () => {
  it("asks once for a number, however often the thread re-renders", async () => {
    const { index, asked } = probe();

    await index.lookup("/p", [12]);
    await index.lookup("/p", [12]);
    await index.lookup("/p", [12, 12]);

    expect(asked).toEqual([12]);
  });

  it("remembers a number that resolved to nothing", async () => {
    // Otherwise every render retries a number that will never resolve, and a
    // thread mentioning #404 hammers GitHub for the life of the daemon.
    const { index, asked } = probe();

    await index.lookup("/p", [404]);
    await index.lookup("/p", [404]);

    expect(asked).toEqual([404]);
  });

  it("asks again once the answer is old enough to have changed", async () => {
    let clock = 0;
    const { index, asked } = probe(() => clock);

    await index.lookup("/p", [12]);
    clock = 11 * 60 * 1000;
    await index.lookup("/p", [12]);

    expect(asked).toEqual([12, 12]);
  });
});
