import { describe, it, expect } from "vitest";
import { benchManifest } from "../src/daemon/manifest.js";

const manifest = (token = "tok-123") => benchManifest(token) as any;

describe("the web app manifest", () => {
  it("launches at a URL that is already authorised", () => {
    // An installed cockpit has no address bar. If start_url has no token, the
    // app opens to a stale-link banner every single time.
    expect(manifest().start_url).toBe("/?token=tok-123");
  });

  it("escapes a token that would otherwise break the query", () => {
    expect(manifest("a b&c").start_url).toBe("/?token=a%20b%26c");
  });

  it("keeps the token out of the identity, so a new one is not a new app", () => {
    // The id is how a browser recognises an install it already has. With the
    // token in it, every restart of the daemon would install a second Bench.
    expect(manifest().id).toBe("/bench");
    expect(JSON.stringify(manifest().id)).not.toContain("tok-123");
  });

  it("owns the whole origin, so /s/<id> is inside the installed app", () => {
    expect(manifest().scope).toBe("/");
  });

  it("opens in its own window, in the cockpit's own colours", () => {
    expect(manifest().display).toBe("standalone");
    expect(manifest().theme_color).toBe("#0b1210");
    expect(manifest().background_color).toBe("#0b1210");
  });

  it("offers a maskable icon, so a launcher does not crop the mark", () => {
    const maskable = manifest().icons.filter((i: any) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].sizes).toBe("512x512");
  });

  it("offers the two sizes a manifest is asked for, as PNG", () => {
    const png = manifest().icons.filter((i: any) => i.type === "image/png" && i.purpose === "any");
    expect(png.map((i: any) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
  });

  it("carries the token into the shortcut as well, which is a launch too", () => {
    expect(manifest().shortcuts[0].url).toBe("/?token=tok-123#queue");
  });
});
