import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { MODELS } from "../../shared/models.js";

/** One OpenRouter model, as the daemon hands it over. */
export interface Listed {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  /** US dollars per million output tokens, or null when it is not per-token. */
  dollarsPerMillion: number | null;
}

/** Vendors worth putting at the top. Everything else follows alphabetically —
 * these are simply the ones people reach for, not a judgement about the rest. */
const FIRST = ["google", "openai", "anthropic", "meta-llama", "mistralai", "deepseek", "x-ai", "qwen"];

/**
 * How many results are drawn at once.
 *
 * There are getting on for three hundred models, and drawing all of them was
 * the whole problem: sixty headed blocks and a scrollbar with no bottom, in a
 * modal you opened to answer one question. Nobody reads the two hundredth row.
 * The search is the way through the list, so the list only has to be long
 * enough to be worth searching.
 */
const SHOWN = 40;

/**
 * Vendors whose slug is not their name. Everything not named here is shown
 * capitalised, which is right for `google`, `mistralai`, `perplexity` and most
 * of the rest.
 */
const VENDOR_NAMES: Record<string, string> = {
  "x-ai": "xAI",
  "meta-llama": "Meta",
  "mistralai": "Mistral",
  "openai": "OpenAI",
  "deepseek": "DeepSeek",
  "ai21": "AI21",
  "z-ai": "Z.ai",
  "moonshotai": "Moonshot",
  "nvidia": "NVIDIA",
  "openrouter": "OpenRouter",
  "thudm": "THUDM",
  "minimax": "MiniMax",
  "nousresearch": "Nous Research",
  "cognitivecomputations": "Cognitive Computations",
  "arcee-ai": "Arcee",
  "inception": "Inception",
  "tngtech": "TNG",
};

function vendorName(vendor: string): string {
  return VENDOR_NAMES[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/**
 * The model's own name, with the vendor taken off the front.
 *
 * OpenRouter names every model "Google: Gemini 3.7 Flash". Under a Google
 * heading, next to the id `google/gemini-3.7-flash`, that is the third time
 * the reader has been told who makes it - and it is what pushed rows onto two
 * lines and made the list twice as tall as it needed to be.
 */
function shortName(model: Listed): string {
  const colon = model.name.indexOf(": ");
  return colon === -1 ? model.name : model.name.slice(colon + 2);
}

/** The window, in the units people say it in. */
function window_(length: number | null): string {
  if (length === null) return "";
  return length >= 1_000_000
    ? `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
    : `${Math.round(length / 1000)}k`;
}

/**
 * What a million tokens of its output costs.
 *
 * Shown because these turns are billed to the developer's own OpenRouter
 * account rather than to a subscription already paid for, and because the
 * spread across the catalogue is two orders of magnitude - which makes it the
 * fact that actually decides between two models that read alike.
 */
function price(dollars: number | null): string {
  if (dollars === null) return "";
  if (dollars === 0) return "free";
  return dollars < 10 ? `$${dollars.toFixed(2)}/M` : `$${Math.round(dollars)}/M`;
}

/**
 * How well a model answers what was typed, higher being better, 0 being not at
 * all.
 *
 * Ranked rather than merely filtered because the answer to "gpt" is not forty
 * models in catalogue order - it is GPT first. A substring filter put
 * `openai/gpt-5.6-luna` below whatever happened to be listed before it.
 */
function score(model: Listed, needle: string): number {
  if (needle === "") return 1;
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const bare = id.slice(id.indexOf("/") + 1);

  if (id === needle || bare === needle) return 6;
  if (bare.startsWith(needle)) return 5;
  if (id.startsWith(needle)) return 4;
  // The start of any word, which is how people search: "flash" should find
  // "Gemini 3.7 Flash" as readily as "gemini" does.
  if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) return 3;
  if (id.includes(needle) || name.includes(needle)) return 2;
  return 0;
}

/**
 * Which model a specialist runs on.
 *
 * A modal rather than a dropdown because the choice stopped being four names
 * the moment OpenRouter was in it: there are hundreds of models across dozens
 * of vendors, and two entries in that list can differ in who bills you, how
 * much they hold, and whether a key is set at all. None of that fits in an
 * `<option>`.
 *
 * Anthropic's four come first and always work — they go straight to Anthropic
 * on the login this machine already has. Everything below them is reached
 * through OpenRouter and needs a key, and is shown without one rather than
 * hidden: "you could run this, here is what it needs" is worth more than a
 * list that quietly omits most of what the bench supports.
 *
 * The list below the search is one column rather than a grid of headed blocks,
 * and it is capped. Both for the same reason: the search is how anyone gets
 * to the two hundredth model, so the list only has to be long enough to browse
 * — and a row that reads left to right, name then window then price, can be
 * scanned down a column in a way that cards in a grid cannot.
 */
export function ModelDialog({
  open, current, onClose, onPick, onNeedKey, sessionId, id = "model-dialog",
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onPick?: (model: string) => void;
  /**
   * Take the developer to where a key is set. Absent where Settings cannot be
   * reached from — the note still says what is needed, there is simply no
   * button to press.
   */
  onNeedKey?: () => void;
  /** The specialist to move. Absent means the pick is simply reported back,
   * which is what makes this same modal usable before one exists. */
  sessionId?: string;
  /**
   * Two of these can be mounted at once - the composer's and the new
   * specialist dialog's - and two elements sharing an id is invalid markup
   * that silently hands every lookup to whichever came first.
   *
   * Which is why every id inside is built from this one rather than written
   * out. The controls used to carry fixed ids, so with both mounted there
   * were two `#model-search` boxes and two of everything else - and a click
   * on the second dialog's button ran the first dialog's handler.
   */
  id?: string;
}) {
  /** This dialog's own name for one of its controls. */
  const own = (part: string) => `${id}-${part}`;
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [listed, setListed] = useState<Listed[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which result the arrow keys are on. -1 is none, which is where it starts:
   * opening the picker should not preselect a model nobody asked for. */
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close?.(); return; }

    setError("");
    setQuery("");
    setActive(-1);
    dialog.showModal?.();
    // Put the caret in the search box, because searching is what this modal
    // is for. `autoFocus` is not enough: showModal() takes focus itself and
    // hands it to the first focusable thing in the dialog, which is Opus.
    searchRef.current?.focus?.();

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

  /** The catalogue, ranked against what has been typed and cut to length. */
  const { rows, total } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scored = listed
      .map((model) => ({ model, hit: score(model, needle) }))
      .filter((row) => row.hit > 0)
      .sort((a, b) => {
        if (a.hit !== b.hit) return b.hit - a.hit;
        const ai = FIRST.indexOf(a.model.vendor);
        const bi = FIRST.indexOf(b.model.vendor);
        if (ai !== bi) return (ai === -1 ? FIRST.length : ai) - (bi === -1 ? FIRST.length : bi);
        return a.model.name.localeCompare(b.model.name);
      })
      .map((row) => row.model);

    // The one it is already on always makes the cut, wherever it ranks. A
    // picker that cannot show you what you would be changing from is asking
    // you to remember it.
    const pinned = scored.findIndex((m) => m.id === current);
    const ordered = pinned > 0
      ? [scored[pinned]!, ...scored.slice(0, pinned), ...scored.slice(pinned + 1)]
      : scored;

    return { rows: ordered.slice(0, SHOWN), total: scored.length };
  }, [listed, query, current]);

  // An arrow key that runs off the end of a filtered list would leave the
  // highlight on a row that is no longer there.
  useEffect(() => { setActive((at) => (at >= rows.length ? rows.length - 1 : at)); }, [rows.length]);

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

  /**
   * Arrows and Enter, handled on the search box so the caret never leaves it.
   *
   * This is the difference between a list you search and a list you scroll:
   * with several hundred models, typing three letters and pressing Enter has
   * to be the whole interaction, and moving focus onto the rows to get there
   * would mean typing, reaching for the mouse, and losing the query.
   */
  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0 || !hasKey) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => {
        const next = at + step;
        if (next < 0) return -1;
        return next >= rows.length ? rows.length - 1 : next;
      });
      return;
    }
    if (event.key === "Enter" && active >= 0 && rows[active] && hasKey) {
      event.preventDefault();
      void choose(rows[active]!.id);
    }
  };

  // Keep the highlighted row in sight while the arrows walk past the fold.
  useEffect(() => {
    if (active < 0) return;
    const row = ref.current?.querySelector(`[data-at="${active}"]`);
    // Guarded rather than assumed: this is the one call in here that a
    // rendering environment is allowed not to have.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  return (
    <dialog id={id} className="sheet" ref={ref} onClose={onClose}>
      <h2>Model</h2>
      <p className="field-note" id={own("note")}>
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

      <section id={own("router")} className="model-house model-router">
        <h3>Everything else</h3>
        <p className="field-note" id={own("router-note")}>
          {hasKey
            ? "Reached through OpenRouter and billed to that account, not to Anthropic."
            : "These run on your own OpenRouter account. Add a key to use them."}
        </p>

        {/* One bar, one action. The old note pointed at Settings and stopped
            there, which left the developer in a modal reading about a thing
            they could not go and do. */}
        {!hasKey && onNeedKey && (
          <button type="button" id={own("need-key")} className="model-need-key" onClick={onNeedKey}>
            Add an OpenRouter key
          </button>
        )}

        <input
          id={own("search")}
          className="model-search"
          ref={searchRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          aria-controls={own("results")}
          placeholder={listed.length > 0
            ? `Search ${listed.length} models — gemini, gpt, llama…`
            : "Search models — gemini, gpt, llama…"}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(-1); }}
          onKeyDown={onSearchKey}
        />

        {rows.length === 0 && listed.length > 0 && (
          <p className="field-note model-tally" id={own("none")}>Nothing matches “{query}”.</p>
        )}

        <div id={own("results")} role="listbox" className="model-rows">
          {rows.map((model, at) => {
            // The vendor is said once per run of rows rather than on every
            // one, so grouping survives without sixty headed blocks.
            const heads = at === 0 || rows[at - 1]!.vendor !== model.vendor;
            return (
              <div key={model.id} className="model-run">
                {heads && <h4 className="model-vendor">{vendorName(model.vendor)}</h4>}
                <button
                  type="button"
                  role="option"
                  className="model-row"
                  data-model={model.id}
                  data-at={at}
                  data-current={model.id === current}
                  data-active={at === active}
                  aria-selected={model.id === current}
                  aria-current={model.id === current}
                  disabled={busy || !hasKey}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => void choose(model.id)}
                >
                  <b>{shortName(model)}</b>
                  <span className="model-id">{model.id}</span>
                  <span className="model-window">{window_(model.contextLength)}</span>
                  <span className="model-price">{price(model.dollarsPerMillion)}</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* Said rather than silently done. A list that stops at forty without
            saying so reads as a list of forty. */}
        {total > rows.length && (
          <p className="field-note model-tally" id={own("more")}>
            {rows.length} of {total}. Keep typing to narrow it.
          </p>
        )}
      </section>

      {error && <p id={own("error")} className="error">{error}</p>}

      <div className="actions">
        <button type="button" id={own("close")} onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
