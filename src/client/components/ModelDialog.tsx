import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { MODELS, DEVIN_MODEL, DEVIN_PREFIX, isDevinModel, modelLabel, REASONING_EFFORT_NOTE } from "../../shared/models.js";
import { costOfTurn, dollars, multipleLabel, multipleOf, type Price } from "../../shared/cost.js";
import { AutoRouters, isAutoRouter } from "./AutoRouters.js";
import { ModelRow, shortName, windowLabel, type Listed } from "./ModelRow.js";
import { useTurnShape } from "./useTurnShape.js";

export type { Listed };

/** A Devin model family, from `/api/devin/models` (#114) — not the daemon's
 * own `DevinFamily`, kept as its own local shape the way `Listed` above is
 * kept separate from the daemon's, so the client never has to import daemon
 * code to draw a picker row. */
interface DevinFamily {
  id: string;
  label: string;
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
 * What the model the specialist is on charges, so everything else can be
 * quoted against it.
 *
 * Anthropic's four are not billed per token on this bench at all - they go to
 * a subscription already paid for - so the comparison uses their list price
 * through OpenRouter, and the legend says that is what it is doing. Without
 * it there is no baseline at all for the model most benches sit on.
 */
function baselineFor(current: string, listed: Listed[]): Price | null {
  return listed.find((m) => m.id === currentId(current))?.price ?? null;
}

/** The catalogue id for whatever the specialist is on - an OpenRouter id is
 * already one, and an Anthropic alias resolves to the model it follows. */
function currentId(current: string): string {
  const known = MODELS.find((m) => m.id === current);
  return known ? `anthropic/${known.resolves}` : current;
}

/** Nothing quoted, anywhere. A model the catalogue has never heard of. */
const EMPTY_PRICE: Price = { fresh: null, cacheWrite: null, cacheRead: null, out: null };

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
 * Devin comes first and needs nothing but the login this machine already
 * has — it is what this bench runs on now (#141). Anthropic's four, the
 * auto-routers and the OpenRouter catalogue all sit behind a setting the
 * developer turns on in Settings: shown without a key when they are shown at
 * all rather than hidden for want of one, since "you could run this, here is
 * what it needs" is worth more than a list that quietly omits most of what
 * the bench supports. Whichever of those a specialist is already running on,
 * that one model stays visible and pickable even with its house hidden - see
 * `currentInHiddenHouse` below.
 *
 * The catalogue below the search is one column rather than a grid of headed
 * blocks, and it is capped. Both for the same reason: the search is how
 * anyone gets to the two hundredth model, so the list only has to be long
 * enough to browse — and a row that reads left to right, name then window
 * then price, can be scanned down a column in a way that cards in a grid
 * cannot.
 */
export function ModelDialog({
  open, current, onClose, onPick, onNeedKey, sessionId, standing = false, id = "model-dialog", reasoningEffort,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onPick?: (model: string, reasoningEffort?: "none" | "low" | "medium" | "high") => void;
  /** Set from Settings, where the choice is a standing default for a role
   * rather than a model for one specialist - the note has to say which. */
  standing?: boolean;
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
  reasoningEffort?: "none" | "low" | "medium" | "high";
}) {
  /** This dialog's own name for one of its controls. */
  const own = (part: string) => `${id}-${part}`;
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [listed, setListed] = useState<Listed[]>([]);
  const [hasKey, setHasKey] = useState(false);
  /** Devin's model families (#114), read fresh every time the dialog opens.
   * Empty either while still loading or because the daemon could not read
   * them - `devin models list` has been observed refusing intermittently -
   * and the two are drawn the same way: the account default button below is
   * offered regardless, since it needs nothing from this list. */
  const [devinFamilies, setDevinFamilies] = useState<DevinFamily[]>([]);
  /** Whether every house is shown, or just Devin - the developer's own
   * setting (`shared/settings.ts`), read fresh every time the dialog opens
   * the same way `devinFamilies` and `listed` are. */
  const [allHouses, setAllHouses] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [effort, setEffort] = useState<"none" | "low" | "medium" | "high">("medium");
  /**
   * What `effort` was seeded to when the dialog opened, so a later comparison
   * can tell "still what it started as" from "the developer touched this".
   *
   * The prop it is seeded from, `reasoningEffort`, is `undefined` for any
   * specialist whose session record predates the field - which is every
   * long-lived tab on this bench. Comparing `effort` against that prop
   * directly meant `"medium" !== undefined` was always true, so picking a
   * model the specialist was already on still looked like an effort change
   * and stopped it for nothing.
   */
  const [initialEffort, setInitialEffort] = useState<"none" | "low" | "medium" | "high">("medium");
  /** Which result the arrow keys are on. -1 is none, which is where it starts:
   * opening the picker should not preselect a model nobody asked for. */
  const [active, setActive] = useState(-1);
  /** Ranked by price rather than by how well the name matches. Off by
   * default: most openings of this dialog are somebody looking for a model
   * they can already name. */
  const [cheapest, setCheapest] = useState(false);
  /** The turn every price here is worked out against - the developer's own,
   * averaged, or a stated assumption until this bench has run some. */
  const { shape, turns } = useTurnShape(open);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close?.(); return; }

    setError("");
    setQuery("");
    setActive(-1);
    setCheapest(false);
    const seeded = reasoningEffort ?? "medium";
    setEffort(seeded);
    setInitialEffort(seeded);
    dialog.showModal?.();
    // Put the caret in the search box, because searching is what this modal
    // is for. `autoFocus` is not enough: showModal() takes focus itself and
    // hands it to the first focusable thing in the dialog, which is Opus.
    searchRef.current?.focus?.();

    let live = true;
    void (async () => {
      const [keyRes, modelsRes, devinRes, settingsRes] = await Promise.all([
        authFetch("/api/openrouter/keys"),
        authFetch("/api/openrouter/models"),
        authFetch("/api/devin/models"),
        authFetch("/api/settings"),
      ]);
      if (!live) return;
      if (keyRes.ok) setHasKey(((await keyRes.json())?.credentials ?? []).some((c: { active?: boolean }) => c.active === true));
      if (modelsRes.ok) setListed((await modelsRes.json())?.models ?? []);
      else {
        // Anthropic's four still work, so this is a note rather than a
        // failure. Saying nothing would look like OpenRouter has no models.
        setListed([]);
        setError("Could not read OpenRouter's model list. Anthropic's models still work.");
      }
      // No note on failure here the way OpenRouter gets one above: the
      // account default is always offered and needs nothing from this list,
      // so an empty result reads the same whether the daemon could not run
      // `devin models list` or simply found nothing else to add.
      setDevinFamilies(devinRes.ok ? ((await devinRes.json())?.families ?? []) : []);
      // A daemon that cannot be asked reads as "just Devin" - the safe
      // default, not a picker that silently opens onto everything.
      setAllHouses(settingsRes.ok ? ((await settingsRes.json())?.settings?.allHouses ?? false) : false);
    })();
    return () => { live = false; };
  }, [open]);

  /** What a turn like the developer's costs on each model, worked out once. */
  const priced = useMemo(() => {
    const baseline = costOfTurn(shape, baselineFor(current, listed) ?? EMPTY_PRICE);
    return new Map(listed.map((model) => {
      const turn = costOfTurn(shape, model.price);
      return [model.id, { turn, multiple: multipleOf(turn, baseline) }];
    }));
  }, [listed, shape, current]);

  /** What the developer is comparing against, in the words the picker uses
   * for it elsewhere. */
  const currentLabel = MODELS.find((m) => m.id === current)?.label
    ?? (isDevinModel(current) ? modelLabel(current) : undefined)
    ?? shortName(listed.find((m) => m.id === current) ?? { id: current, name: current, vendor: "", contextLength: null, price: EMPTY_PRICE });

  /**
   * The cheapest model in the catalogue that still holds as much as the one
   * the specialist is on.
   *
   * Arithmetic, not a recommendation. Cheap is not the same as able, and the
   * only part of "able" a price list can answer is whether the conversation
   * will fit - so that is the only claim made. Nothing is said at all unless
   * it would actually save something.
   */
  const saving = useMemo(() => {
    const now = priced.get(currentId(current))?.turn ?? null;
    const window = listed.find((m) => m.id === currentId(current))?.contextLength ?? null;
    if (now === null || window === null) return null;

    let best: { model: Listed; turn: number } | null = null;
    for (const model of listed) {
      const turn = priced.get(model.id)?.turn ?? null;
      if (turn === null || (model.contextLength ?? 0) < window) continue;
      // Never the free variants. They are throttled preview endpoints, and a
      // specialist that has to finish a turn cannot rely on one - recommending
      // it as the saving is advice that costs an afternoon to take.
      if (model.id.endsWith(":free")) continue;
      if (best === null || turn < best.turn) best = { model, turn };
    }
    if (best === null || best.turn >= now * 0.95) return null;

    return { ...best, window, now, times: multipleLabel(multipleOf(best.turn, now)) };
  }, [listed, priced, current]);

  /** The catalogue, ranked against what has been typed and cut to length. */
  const { rows, total } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scored = listed
      // Drawn in their own block above, where their not having a price is the
      // point rather than a hole in a column of figures.
      .filter((model) => !isAutoRouter(model.id))
      .map((model) => ({ model, hit: score(model, needle) }))
      .filter((row) => row.hit > 0)
      .sort((a, b) => {
        // Cheapest first is sorted on the estimated cost of a turn, never on
        // the output price: ordering by the wrong number is the whole reason
        // this picker needed rebuilding.
        if (cheapest) {
          const at = priced.get(a.model.id)?.turn;
          const bt = priced.get(b.model.id)?.turn;
          // A model that will not quote a price sorts last rather than first.
          // Unknown is not free, and free is not what nobody would pick.
          if (at !== bt) return (at ?? Infinity) - (bt ?? Infinity);
          return a.model.name.localeCompare(b.model.name);
        }
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
  }, [listed, query, current, cheapest, priced]);

  /** Devin's families, narrowed by the same query and capped the same way as
   * the catalogue above - the account default itself is not in this list
   * (it needs nothing from a search) and is always drawn regardless. */
  const { devinRows, devinTotal } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scored = devinFamilies
      .map((family) => ({
        family,
        hit: score({ id: family.id, name: family.label, vendor: "", contextLength: null, price: EMPTY_PRICE }, needle),
      }))
      .filter((row) => row.hit > 0)
      .sort((a, b) => (a.hit !== b.hit ? b.hit - a.hit : a.family.label.localeCompare(b.family.label)))
      .map((row) => row.family);

    const pinned = scored.findIndex((f) => `${DEVIN_PREFIX}${f.id}` === current);
    const ordered = pinned > 0
      ? [scored[pinned]!, ...scored.slice(0, pinned), ...scored.slice(pinned + 1)]
      : scored;

    return { devinRows: ordered.slice(0, SHOWN), devinTotal: scored.length };
  }, [devinFamilies, query, current]);

  /**
   * Every row the arrows and Enter can land on, in the order the dialog
   * draws them: Devin's account default, then its families, then the
   * catalogue - which is empty here whenever that house is hidden or there
   * is no key to reach it, the same rule that disables its rows to a mouse.
   *
   * Anthropic's four are not in here. They are never filtered by the
   * search, so there was never a "which one does Enter pick" question for
   * arrows to answer among them.
   */
  const navRows = useMemo(() => {
    const nav: Array<{ model: string }> = [{ model: DEVIN_MODEL }];
    for (const family of devinRows) nav.push({ model: `${DEVIN_PREFIX}${family.id}` });
    if (allHouses && hasKey) for (const model of rows) nav.push({ model: model.id });
    return nav;
  }, [devinRows, allHouses, hasKey, rows]);

  // An arrow key that runs off the end of a filtered list would leave the
  // highlight on a row that is no longer there.
  useEffect(() => { setActive((at) => (at >= navRows.length ? navRows.length - 1 : at)); }, [navRows.length]);

  /**
   * The specialist's own model, orphaned by the setting rather than by the
   * search: Devin is always drawn, but Anthropic's four, the auto-routers
   * and the OpenRouter catalogue all vanish when the setting is off, and a
   * specialist already running one of those must not lose sight of what it
   * is on.
   */
  const currentInHiddenHouse = !allHouses && !isDevinModel(current);

  const choose = async (model: string) => {
    if (model === current && effort === initialEffort) { onClose(); return; }
    setError("");

    // Nothing to move: report the pick and let the caller hold it.
    if (sessionId === undefined) {
      onPick?.(model, effort);
      onClose();
      return;
    }

    setBusy(true);
    try {
      if (model !== current) {
        const res = await postJson(`/api/sessions/${sessionId}/model`, { model });
        const body = await res.json();
        if (!res.ok) {
          // The daemon's own words. It is the one that knows whether a key is
          // missing or the model was refused.
          setError(body?.error ?? "Could not change the model.");
          return;
        }
      }
      if (effort !== initialEffort) {
        const res = await postJson(`/api/sessions/${sessionId}/reasoning-effort`, { reasoningEffort: effort });
        const body = await res.json();
        if (!res.ok) {
          setError(body?.error ?? "Could not change reasoning effort.");
          return;
        }
      }
      onPick?.(model, effort);
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
      if (navRows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => {
        const next = at + step;
        if (next < 0) return -1;
        return next >= navRows.length ? navRows.length - 1 : next;
      });
      return;
    }
    if (event.key === "Enter" && active >= 0 && navRows[active]) {
      event.preventDefault();
      void choose(navRows[active]!.model);
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

  // Devin's own rows start at nav index 1 (0 is the account default) - the
  // catalogue's rows, when they are drawn at all, pick up right after.
  const catalogueOffset = 1 + devinRows.length;

  return (
    <dialog
      id={id}
      className="sheet"
      ref={ref}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <h2>Model</h2>
      <p className="field-note" id={own("note")}>
        {standing
          ? "What this kind of work starts on, unless you say otherwise when you make one."
          : sessionId === undefined
          ? "What this specialist will start on."
          : "Takes effect on the next prompt — the specialist restarts on the "
            + "new model and picks the conversation up where it left off."}
      </p>

      {/* First control in the dialog, above every list it filters - Devin's
          families and, when that house is open, the catalogue below it. */}
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

      {/* First house: this is what the bench runs on now, and the one that
          needs nothing from a setting to show up. */}
      <section className="model-house" data-house="devin">
        <h3>Devin</h3>
        <p className="field-note" data-house-note="devin">
          Runs on the Devin agent installed on this machine. Requires{" "}
          <code>devin auth login</code> once. No API key, no per-turn charge in Bench.
          {devinFamilies.length === 0 && (
            <> Its own model list could not be read just now — the account default still works.</>
          )}
        </p>
        <div className="model-options">
          <button
            type="button"
            className="model-option"
            data-model={DEVIN_MODEL}
            data-at={0}
            data-active={active === 0}
            data-current={current === DEVIN_MODEL}
            aria-current={current === DEVIN_MODEL}
            disabled={busy}
            onClick={() => void choose(DEVIN_MODEL)}
            onMouseEnter={() => setActive(0)}
          >
            <b>Account default</b>
            <span>whatever the Devin account is set to</span>
          </button>
          {devinRows.map((family, i) => {
            const modelId = `${DEVIN_PREFIX}${family.id}`;
            const at = i + 1;
            return (
              <button
                type="button"
                key={modelId}
                className="model-option"
                data-model={modelId}
                data-at={at}
                data-active={active === at}
                data-current={current === modelId}
                aria-current={current === modelId}
                disabled={busy}
                onClick={() => void choose(modelId)}
                onMouseEnter={() => setActive(at)}
              >
                <b>{family.label}</b>
                <span>{family.id}</span>
              </button>
            );
          })}
        </div>
        {/* Said rather than silently done, the same as the catalogue below -
            a list that stops at forty without saying so reads as forty. */}
        {devinTotal > devinRows.length && (
          <p className="field-note model-tally" id={own("devin-more")}>
            {devinRows.length} of {devinTotal}. Keep typing to narrow it.
          </p>
        )}
      </section>

      {/* The specialist's own model, orphaned by the setting rather than by
          the search. Anthropic, the auto-routers and the catalogue all
          disappear when the setting is off - this is the one row from
          whichever of those it is on that does not. */}
      {currentInHiddenHouse && (
        <section className="model-house" data-house="current">
          <h3>Current model</h3>
          <p className="field-note" data-house-note="current">
            Its house is hidden by the "Show every model house" setting, but
            what a specialist is already on always stays visible here.
          </p>
          <div className="model-options">
            <button
              type="button"
              className="model-option"
              data-model={current}
              data-current={true}
              aria-current={true}
              disabled={busy}
              onClick={() => void choose(current)}
            >
              <b>{currentLabel}</b>
              <span>{current}</span>
            </button>
          </div>
        </section>
      )}

      {allHouses && (
        <section className="model-house" data-house="anthropic">
          <h3>Anthropic</h3>
          <p className="field-note" data-house-note="anthropic">
            This machine's Claude login, or the key in your profile. Nothing else has
            to be set up — and these are billed to your Claude plan, not per token,
            so there is no per-turn price to quote against them.
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
      )}

      {/* Above the catalogue, and only where a key can reach them. A block
          offering to route requests on an account that does not exist is a
          block that cannot do anything. */}
      {allHouses && hasKey && (
        <AutoRouters current={current} disabled={busy} onPick={(model) => void choose(model)} />
      )}

      {/* Below the models it cannot change, not above them: this has no
          effect on Anthropic's four, so it used to sit where it read as
          applying to the section directly beneath it. It sits right before
          the catalogue it actually governs instead. Visible in both modes -
          it governs Anthropic and Devin alike. */}
      <section className="model-house" data-house="thinking-effort">
        <h3>Thinking Effort</h3>
        <p className="field-note">{REASONING_EFFORT_NOTE}</p>
        <div className="effort-options">
          {(["none", "low", "medium", "high"] as const).map((level) => (
            <button
              type="button"
              key={level}
              className="effort-option"
              data-current={effort === level}
              aria-current={effort === level}
              disabled={busy}
              onClick={() => setEffort(level)}
            >
              <b>{level === "none" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1)}</b>
              <span>{level === "none" ? "minimal" : `${level} effort`}</span>
            </button>
          ))}
        </div>
      </section>

      {allHouses && (
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

          {/* One line, where a legend and a basis note used to be two. The
              legend existed to decode three bare dollar figures on every row;
              the rows say what they mean now, so it has nothing left to
              explain. What remains is the one thing a price cannot say about
              itself: which turn it is the price of. */}
          <div className="model-strip">
            <p className="model-basis" id={own("basis")}>
              Cost of one turn{" "}
              {turns > 1 && <>like your last {turns}</>}
              {turns === 1 && <>like the one this bench has run</>}
              {turns === 0 && <>on an assumed turn, until this bench has run some</>}
              , against {currentLabel}.
            </p>
            {/* Labelled as the thing it will do, not as the state it is in. A
                toggle that names its own state reads as a claim about the list
                you are looking at. */}
            <button
              type="button"
              id={own("cheapest")}
              className="model-sort"
              aria-pressed={cheapest}
              onClick={() => { setCheapest((on) => !on); setActive(-1); }}
            >
              {cheapest ? "Sort by match" : "Sort by price"}
            </button>
          </div>

          {/* The saving, said out loud rather than left to be noticed. It is
              arithmetic, not a recommendation: cheap is not the same as able,
              and the window is the one part of "able" a catalogue can answer. */}
          {saving && (
            <p className="field-note model-saving" id={own("saving")}>
              <b>{shortName(saving.model)}</b> is the cheapest here that still
              holds {windowLabel(saving.window)} —{" "}
              {saving.turn === 0 ? "free" : dollars(saving.turn)} a turn against{" "}
              {dollars(saving.now)}.
            </p>
          )}

          {rows.length === 0 && listed.length > 0 && (
            <p className="field-note model-tally" id={own("none")}>Nothing matches “{query}”.</p>
          )}

          <div id={own("results")} role="listbox" className="model-rows">
            {rows.map((model, i) => {
              // The vendor is said once per run of rows rather than on every
              // one, so grouping survives without sixty headed blocks.
              const heads = i === 0 || rows[i - 1]!.vendor !== model.vendor;
              const at = catalogueOffset + i;
              return (
                <div key={model.id} className="model-run">
                  {heads && <h4 className="model-vendor">{vendorName(model.vendor)}</h4>}
                  <ModelRow
                    model={model}
                    at={at}
                    active={at === active}
                    current={model.id === current}
                    disabled={busy || !hasKey}
                    turn={priced.get(model.id)?.turn ?? null}
                    multiple={priced.get(model.id)?.multiple ?? null}
                    onPick={() => void choose(model.id)}
                    onHover={() => setActive(at)}
                  />
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
      )}

      {error && <p id={own("error")} className="error">{error}</p>}

      <div className="actions">
        <button type="button" id={own("close")} onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
