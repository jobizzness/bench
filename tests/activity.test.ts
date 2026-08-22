import { describe, it, expect } from "vitest";
import { appendActivity, TRAIL_LENGTH } from "../src/daemon/activity.js";

const AT = "2026-08-22T02:00:00.000Z";

describe("appendActivity", () => {
  it("keeps what happened, oldest first", () => {
    let trail = appendActivity([], "Read README.md", AT);
    trail = appendActivity(trail, "Edit src/app.js", AT);

    expect(trail.map((a) => a.text)).toEqual(["Read README.md", "Edit src/app.js"]);
  });

  it("keeps only the most recent entries", () => {
    let trail: any[] = [];
    for (let i = 0; i < TRAIL_LENGTH + 5; i += 1) {
      trail = appendActivity(trail, `Edit file-${i}.ts`, AT);
    }

    expect(trail).toHaveLength(TRAIL_LENGTH);
    expect(trail[0].text).toBe("Edit file-5.ts");
    expect(trail.at(-1).text).toBe(`Edit file-${TRAIL_LENGTH + 4}.ts`);
  });

  it("collapses a repeated step into a count", () => {
    // A turn that runs the same command forty times should say so once,
    // not push everything else out of the window.
    let trail = appendActivity([], "Bash pnpm test", AT);
    trail = appendActivity(trail, "Bash pnpm test", AT);
    trail = appendActivity(trail, "Bash pnpm test", AT);

    expect(trail).toHaveLength(1);
    expect(trail[0].text).toBe("Bash pnpm test (×3)");
  });

  it("starts a new entry when the step changes", () => {
    let trail = appendActivity([], "Bash pnpm test", AT);
    trail = appendActivity(trail, "Bash pnpm test", AT);
    trail = appendActivity(trail, "Edit src/app.js", AT);

    expect(trail.map((a) => a.text)).toEqual(["Bash pnpm test (×2)", "Edit src/app.js"]);
  });

  it("stamps each entry, so the cockpit can say how long ago", () => {
    const trail = appendActivity([], "Bash pnpm build", AT);
    expect(trail[0].at).toBe(AT);
  });
});
