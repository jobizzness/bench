/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:7420/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Pointing the cockpit at another daemon is a navigation, and these are
 * links - so what is proved here is the address each one carries, and that
 * the one you are already at is never offered as somewhere to go.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const LAN = { origins: ["http://127.0.0.1:7420", "http://192.168.1.198:7420"], loopbackOnly: false };

const addresses = () => ui.$$("a.s-address") as HTMLAnchorElement[];
const go = () => ui.$<HTMLAnchorElement>("#s-address-go")!;

async function open(where = LAN): Promise<void> {
  ui = await bootCockpit({ rows: [row()], addresses: where });
  await ui.click(ui.$("#open-settings"));
  await waitFor(() => ui.$("#s-server"), "the server section");
}

describe("where this cockpit is pointed", () => {
  it("says which daemon the tab is talking to", async () => {
    await open();
    expect(ui.$("#s-here")!.textContent).toContain("http://127.0.0.1:7420");
  });

  it("offers the other addresses this daemon answers on, carrying the token", async () => {
    await open();

    expect(addresses()).toHaveLength(1);
    expect(addresses()[0].textContent).toContain("192.168.1.198:7420");
    expect(addresses()[0].href).toBe("http://192.168.1.198:7420/?token=t");
  });

  it("does not offer the address you are already at", async () => {
    // Every one of these is a page reload. Offering the current one is a link
    // whose whole effect is to lose your place.
    await open();
    expect(addresses().some((a) => a.href.includes("127.0.0.1"))).toBe(false);
  });

  it("takes a typed address, and has nowhere to go until one is given", async () => {
    await open();
    expect(go().getAttribute("href")).toBeNull();
    expect(go().getAttribute("aria-disabled")).toBe("true");

    await ui.type(ui.$("#s-address"), "10.0.0.5:7420");

    expect(go().href).toBe("http://10.0.0.5:7420/?token=t");
    expect(go().getAttribute("aria-disabled")).toBe("false");
  });

  it("refuses to offer a trip to where you already are", async () => {
    await open();
    await ui.type(ui.$("#s-address"), "127.0.0.1:7420");

    expect(go().getAttribute("href")).toBeNull();
  });

  it("says why there is nowhere else to go when the daemon is on loopback", async () => {
    await open({ origins: ["http://127.0.0.1:7420"], loopbackOnly: true });

    expect(addresses()).toHaveLength(0);
    expect(ui.$("#s-server")!.textContent).toContain("BENCH_LAN=1");
  });

  it("does not save the house rules when Enter is pressed in the address", async () => {
    // It sits inside the settings form, where Enter is a save.
    await open();
    await ui.type(ui.$("#s-address"), "10.0.0.5:7420");
    await ui.pressIn(ui.$("#s-address"), "Enter");

    expect(ui.sent.some((s) => s.url.includes("/api/settings"))).toBe(false);
  });
});
