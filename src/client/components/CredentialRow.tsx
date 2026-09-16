import { fullest } from "../../shared/usage.js";
import { UsageBars } from "./UsageBars.js";
import type { Credential } from "../credential-store.js";

/** "checked 2m ago" - the check that produced a status, said in words. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "resets in 1h 5m" - when a spent key comes back, said in words. */
export function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** One credential, in the Profile dialog's list. */
export function CredentialRow({ credential, billedNote, onRemove, pin }: {
  credential: Credential;
  /** What to say beside a key with no usage windows - a console key is
   * billed, not rationed. */
  billedNote?: string;
  onRemove: (id: string) => void;
  /** Present only on the Anthropic list - see #135. `null` while a pin
   * toggle is mid-request, so the row can say so rather than look idle. */
  pin?: { pinned: boolean; busy: boolean; onToggle: () => void };
}) {
  const full = credential.usage && credential.usage.length > 0 ? fullest(credential.usage) : null;
  const billed = !credential.usage?.length && billedNote && !credential.key.startsWith("sk-ant-oat");

  return (
    <li className="credential-row">
      <div className="credential-row-head">
        <div>
          <b>{credential.label}</b>
          <span>{credential.hint}</span>
          {full && <span>{full.label} {full.percent}%</span>}
          {credential.status === "exhausted" && credential.resetsAt && (
            <span>resets in {until(credential.resetsAt)}</span>
          )}
          {billed && <span>{billedNote}</span>}
        </div>
        <div className="credential-row-actions">
          {credential.active && <span className="credential-active">In use</span>}
          <span className={`credential-status ${credential.status}`}>{credential.status}</span>
          {credential.checkedAt > 0 && <span>checked {ago(credential.checkedAt)}</span>}
          {pin && (
            <button
              type="button"
              className="credential-pin"
              data-pinned={pin.pinned}
              aria-pressed={pin.pinned}
              disabled={pin.busy}
              onClick={pin.onToggle}
            >
              {pin.pinned ? "Pinned" : "Pin"}
            </button>
          )}
          <button type="button" className="credential-remove" onClick={() => onRemove(credential.id)}>
            Remove
          </button>
        </div>
      </div>
      {credential.usage && credential.usage.length > 0 && (
        <div className="credential-usage"><UsageBars windows={credential.usage} /></div>
      )}
    </li>
  );
}
