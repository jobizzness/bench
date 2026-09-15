/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "./helpers/wait-for.js";
import { ProfileDialog } from "../src/client/components/ProfileDialog.js";

/**
 * The profile is the only home the keys have. What it draws has to say which
 * one is being spent - the daemon knows and Firestore does not, so the answer
 * is stitched together here and nowhere else.
 */

vi.mock("firebase/auth", () => ({
  getAuth: () => ({ currentUser: { getIdToken: async () => "tok" } }),
}));
vi.mock("../src/client/firebase-app.js", () => ({ firebaseApp: () => ({}) }));

/** jsdom reflects `open` but implements neither method the dialog needs. */
const proto = (globalThis as any).HTMLDialogElement?.prototype;
if (proto && !proto.showModal) {
  proto.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
}

const doc = (id: string, label: string, key: string, status = "unchecked", resetsAt?: string) => ({
  name: `projects/p/databases/(default)/documents/users/u1/anthropicCredentials/${id}`,
  fields: {
    key: { stringValue: key },
    label: { stringValue: label },
    hint: { stringValue: `…${key.slice(-4)}` },
    status: { stringValue: status },
    checkedAt: { integerValue: "0" },
    createdAt: { integerValue: "1" },
    ...(resetsAt !== undefined ? { resetsAt: { stringValue: resetsAt } } : {}),
  },
});

const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

let host: HTMLDivElement;
let root: Root;
let patched: Array<{ url: string; body: any }>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

async function open(): Promise<void> {
  const checkedA = Date.now() - 120_000;
  const checkedB = Date.now() - 60_000;
  const resetsA = new Date(Date.now() + 3_600_000).toISOString();
  patched = [];

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") patched.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/openRouterCredentials")) {
      if (init?.method === "PATCH" || init?.method === "DELETE") return reply(200, {});
      return reply(404, {});
    }
    if (url.includes("/anthropicCredentials")) {
      if (init?.method === "PATCH" || init?.method === "DELETE") return reply(200, {});
      return reply(200, { documents: [doc("a", "Primary", "sk-ant-oat01-aaaaaaaaaaaa"), doc("b", "Backup", "sk-ant-oat01-bbbbbbbbbbbb")] });
    }
    if (url.includes("/api/anthropic-keys")) {
      return reply(200, {
        credentials: [
          {
            id: "a", label: "Primary", status: "exhausted", checkedAt: checkedA, active: false,
            usage: [{ key: "five_hour", label: "5-hour", percent: 100, resetsAt: resetsA }],
            resetsAt: resetsA,
          },
          {
            id: "b", label: "Backup", status: "available", checkedAt: checkedB, active: true,
            usage: [{ key: "five_hour", label: "5-hour", percent: 41, resetsAt: null }],
          },
        ],
      });
    }
    if (url.includes("/api/openrouter/keys")) return reply(200, { credentials: [] });
    return reply(200, {});
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <ProfileDialog
        open
        user={{ uid: "u1", email: "d@x" } as any}
        onClose={() => {}}
        onSignIn={async () => {}}
      />,
    );
  });
  await waitFor(() => host.querySelector(".credential-active"), "the active key to be marked");
}

describe("the profile's credential lists", () => {
  it("marks exactly one key as in use, on the row the daemon named", async () => {
    await open();

    const badges = host.querySelectorAll(".credential-active");
    expect(badges).toHaveLength(1);

    const row = badges[0].closest("li")!;
    expect(row.textContent).toContain("Backup");
    expect(row.textContent).not.toContain("Primary");
  });

  it("says which key the specialists are running on, and how spent it is", async () => {
    await open();

    const summaries = [...host.querySelectorAll(".credential-summary")];
    expect(summaries[0].textContent).toContain("Backup");
    expect(summaries[0].textContent).toContain("…bbbb");
    expect(summaries[0].textContent).toContain("5-hour 41% used");
  });

  it("shows what each key has left, and when a spent one comes back", async () => {
    await open();

    const rows = [...host.querySelectorAll(".credential-list li")];
    const backup = rows.find((li) => li.textContent!.includes("Backup"))!;
    expect(backup.textContent).toContain("5-hour 41%");

    const primary = rows.find((li) => li.textContent!.includes("Primary"))!;
    expect(primary.textContent).toContain("exhausted");
    expect(primary.textContent).toContain("resets in");
    expect(primary.textContent).toContain("checked 2m ago");
  });

  it("writes the reset time back to the profile, so the next sync cools down until it", async () => {
    // Without it, the daemon's cooldown is a blind fifteen minutes and a
    // second Bench syncing the same profile never learns when the key
    // comes back.
    await open();

    const write = patched.find((p) => p.url.endsWith("/anthropicCredentials/a"));
    expect(write).toBeDefined();
    expect(write!.body.fields.resetsAt.stringValue).toMatch(/^\d{4}-/);
    expect(write!.body.fields.status.stringValue).toBe("exhausted");
  });

  it("says what the OpenRouter models do without a usable key", async () => {
    await open();

    const summaries = [...host.querySelectorAll(".credential-summary")];
    expect(summaries[1].textContent).toContain("only Anthropic's models are offered");
  });
});
