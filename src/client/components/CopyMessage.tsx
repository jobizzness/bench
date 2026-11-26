import { useEffect, useState } from "react";

/**
 * Copies one message's text. The Clipboard API only exists on a secure
 * origin; a cockpit opened over the LAN by IP is not one, so the old
 * select-and-copy route is the fallback rather than a missing button.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable - fall through to the old way.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

/** The copy icon beside a message's sender. Says "copied" for a moment so a
 * tap on a phone, where nothing else visibly happens, is confirmed. */
export function CopyMessage({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  const label = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy message";

  return (
    <button
      type="button"
      className={`copy-message${state !== "idle" ? ` copy-${state}` : ""}`}
      aria-label={label}
      title={label}
      onClick={() => { void copyText(text).then((ok) => setState(ok ? "copied" : "failed")); }}
    >
      {state === "copied"
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}
      {state !== "idle" && <span className="copy-message-said">{label}</span>}
    </button>
  );
}
