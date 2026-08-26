import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { MODELS } from "../../shared/models.js";

/** One OpenRouter model, as the daemon hands it over. */
export interface Listed {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
}

/** Vendors worth putting at the top. Everything else follows alphabetically —
 * these are simply the ones people reach for, not a judgement about the rest. */
const FIRST = ["google", "openai", "anthropic", "meta-llama", "mistralai", "deepseek", "x-ai", "qwen"];

/**
 * Which model a specialist runs on.
 *
 * A modal rather than a dropdown because the choice stopped being four names
 * the moment OpenRouter was in it: there are several hundred models across
 * dozens of vendors, and two entries in that list can differ in who bills
 * you, how much they hold, and whether a key is set at all. None of that fits
 * in an `<option>`.
 *
 * Anthropic's four come first and always work — they go straight to Anthropic
 * on the login this machine already has. Everything below them needs an
 * OpenRouter key, and is shown disabled rather than hidden when there is
 * none: "you could run this, here is what it needs" is worth more than a list
 * that quietly omits most of what the bench supports.
 */
export function ModelDialog({
  open, current, onClose, onPick, sessionId, id = "model-dialog",
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onPick?: (model: string) => void;
  /** The specialist to move. Absent means the pick is simply reported back,
   * which is what makes this same modal usable before one exists. */
  sessionId?: string;
  /**
   * Two of these can be mounted at once - the composer's and the new
   * specialist dialog's - and two elements sharing an id is invalid markup
   * that silently hands every lookup to whichever came first.
   */
  id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [listed, setListed] = useState<Listed[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close?.(); return; }

    setError("");
    setQuery("");
    dialog.showModal?.();

    let live = true;
    void (async () => {
      const [keyRes, modelsRes] = await Promise.all([
        authFetch("/api/openrouter/key"),
        authFetch("/api/openrouter/models"),
      ]);
      if (!live) return;
      if (keyRes.ok) setHasKey((await keyRes.json())?.present === true);
      if (modelsRes.ok) setListed((await modelsRes.json())?.models ?? []);
      else {
        // Anthropic's four still work, so this is a note rather than a
        // failure. Saying nothing would look like OpenRouter has no models.
        setListed([]);
        setError("Could not read OpenRouter's model list. Anthropic's models still work.");
      }
    })();
    return () => { live = false; };
  }, [open]);

  /** The catalogue, filtered and grouped by vendor. */
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle === ""
      ? listed
      : listed.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));

    const byVendor = new Map<string, Listed[]>();
    for (const model of matching) {
      const bucket = byVendor.get(model.vendor);
      if (bucket) bucket.push(model);
      else byVendor.set(model.vendor, [model]);
    }

    return [...byVendor.entries()].sort(([a], [b]) => {
      const ai = FIRST.indexOf(a);
      const bi = FIRST.indexOf(b);
      if (ai !== bi) return (ai === -1 ? FIRST.length : ai) - (bi === -1 ? FIRST.length : bi);
      return a.localeCompare(b);
    });
  }, [listed, query]);

  const choose = async (model: string) => {
    if (model === current) { onClose(); return; }
    setError("");

    // Nothing to move: report the pick and let the caller hold it.
    if (sessionId === undefined) {
      onPick?.(model);
      onClose();
      return;
    }

    setBusy(true);
    try {
      const res = await postJson(`/api/sessions/${sessionId}/model`, { model });
      const body = await res.json();
      if (!res.ok) {
        // The daemon's own words. It is the one that knows whether a key is
        // missing or the model was refused.
        setError(body?.error ?? "Could not change the model.");
        return;
      }
      onPick?.(model);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog id={id} className="sheet" ref={ref} onClose={onClose}>
      <h2>Model</h2>
      <p className="field-note" id="model-dialog-note">
        {sessionId === undefined
          ? "What this specialist will start on."
          : "Takes effect on the next prompt — the specialist restarts on the "
            + "new model and picks the conversation up where it left off."}
      </p>

      <section className="model-house" data-house="anthropic">
        <h3>Anthropic</h3>
        <p className="field-note" data-house-note="anthropic">
          This machine's Claude login, or the key in Settings. Nothing else has to be set up.
        </p>
        <div className="model-options">
          {MODELS.map((model) => (
            <button
              type="button"
              key={model.id}
              className="model-option"
              data-model={model.id}
              data-current={model.id === current}
              aria-current={model.id === current}
              disabled={busy}
              onClick={() => void choose(model.id)}
            >
              <b>{model.label}</b>
              <span>{model.resolves}</span>
            </button>
          ))}
        </div>
      </section>

      <section id="model-router">
        <h3>Everything else</h3>
        <p className="field-note" id="model-router-note">
          {hasKey
            ? `${listed.length} models through OpenRouter, billed there rather than to Anthropic.`
            : "Needs an OpenRouter key in Settings. These are what one would reach."}
        </p>

        <input
          id="model-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search 400+ models — gemini, gpt, llama…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {groups.length === 0 && listed.length > 0 && (
          <p className="field-note" id="model-none">Nothing matches “{query}”.</p>
        )}

        {groups.map(([vendor, models]) => (
          <section className="model-house" key={vendor} data-house={vendor}>
            <h3>{vendor}</h3>
            <div className="model-options">
              {models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  className="model-option"
                  data-model={model.id}
                  data-current={model.id === current}
                  aria-current={model.id === current}
                  disabled={busy || !hasKey}
                  onClick={() => void choose(model.id)}
                >
                  <b>{model.name}</b>
                  <span>{secondLine(model)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </section>

      {error && <p id="model-dialog-error" className="error">{error}</p>}

      <div className="actions">
        <button type="button" id="model-dialog-close" onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}

/**
 * The id and how much it holds.
 *
 * The window is worth showing here because Bench passes it to the CLI: these
 * models are ones the CLI has never heard of, and left to itself it assumes
 * 200k and compacts there. A million-token model is a different tool from a
 * 200k one, and that is the number that says so.
 */
function secondLine(model: Listed): string {
  if (model.contextLength === null) return model.id;
  const k = model.contextLength >= 1_000_000
    ? `${(model.contextLength / 1_000_000).toFixed(model.contextLength % 1_000_000 === 0 ? 0 : 1)}M`
    : `${Math.round(model.contextLength / 1000)}k`;
  return `${model.id} · ${k}`;
}
