/**
 * What a turn costs, in the terms both ends need.
 *
 * A specialist's turn is not one request. It re-sends the whole conversation
 * on every tool call, so what it spends is mostly input - and mostly input
 * that has already been cached, which is priced at about a tenth of fresh.
 * The picker used to quote output price alone, which is the smallest of the
 * three numbers that decide the bill and the one that changes least between
 * models that read alike.
 *
 * Everything here is arithmetic on a shape and a price. No fetching, no DOM:
 * the daemon prices a turn that happened and the cockpit prices one that
 * might, and both should get the same answer.
 */

/** What one turn put through a model, in tokens. */
export interface TurnShape {
  /** Input the model had not seen before. */
  freshIn: number;
  /** Input written into the cache, charged at a premium. */
  cacheWrite: number;
  /** Input read back out of it, charged at a discount. */
  cacheRead: number;
  /** What the model wrote. */
  out: number;
  /**
   * How many requests were summed to make the three input figures above.
   *
   * Optional, and absent from every shape written before tiered pricing
   * existed. It is here because the numbers beside it are sums over a whole
   * turn, and a sum on its own cannot answer the one question a tiered price
   * asks - how big was the prompt of a single request - without knowing how
   * many things were added up. See `promptPerRequest`, which is the only
   * reader, and `rateForPrompt`, which is what it feeds.
   */
  requests?: number;
}

/** US dollars per million tokens. Null is "not quoted", never zero: a model
 * whose price is decided per request must not be drawn as free. */
export interface Rate {
  fresh: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  out: number | null;
}

/**
 * A rate that only applies once the prompt is big enough.
 *
 * OpenRouter charges dearer for larger prompts on 58 of the 417 models it
 * serves, and it is not a rounding: `qwen/qwen3-coder-flash` - the model this
 * bench reviews with by default - charges 2.67x its quoted rate above 128k
 * prompt tokens, and `google/gemini-3.1-pro-preview` doubles above 200k. A
 * reviewer reading a whole branch is squarely in that territory, so quoting
 * the headline rate is quoting the price of a job nobody asked for.
 *
 * The rate here is complete rather than a patch. OpenRouter's own overrides
 * restate only the figures that change - Gemini's 200k tier names a new
 * prompt, completion and cache-read price and stays silent about cache-write,
 * which means cache-write is unchanged, not unquoted - so whoever builds a
 * tier is responsible for carrying the base rate through the gaps. Doing that
 * once at the edge keeps every reader below dealing in whole prices.
 */
export interface Tier extends Rate {
  /**
   * The prompt size, in tokens, at which this rate starts applying. Inclusive:
   * OpenRouter calls the field `min_prompt_tokens`, and a minimum is a figure
   * you are allowed to be exactly at.
   */
  fromPromptTokens: number;
}

/**
 * What a model charges, per million tokens, at whatever size of prompt.
 *
 * Still the flat four numbers for the overwhelming majority of the catalogue -
 * `tiers` is absent, not empty, on a model without them, so a price written
 * before this existed is still a whole and correct price and compares equal to
 * one. Everything below treats no tiers and a prompt below the first tier as
 * the same case, which is why an untiered model comes out at exactly the
 * figure it came out at yesterday.
 */
export interface Price extends Rate {
  /** Dearer rates for larger prompts, cheapest first. Absent for most models. */
  tiers?: readonly Tier[];
}

/**
 * A turn on this bench when there is no history to average.
 *
 * Sixty thousand in with four fifths of it cached, four thousand out - a
 * middling turn on a middling conversation. Stated here and said out loud
 * wherever it is used: an assumption a developer can see is a caveat, and one
 * they cannot is a lie.
 */
export const ASSUMED_SHAPE: TurnShape = {
  freshIn: 8_000,
  cacheWrite: 4_000,
  cacheRead: 48_000,
  out: 4_000,
};

const MILLION = 1_000_000;

/**
 * How big one request's prompt was, near enough to pick a tier with. Null
 * when the shape does not say how many requests it summed.
 *
 * This is the approximation the whole tiered-pricing feature rests on, so it
 * is worth being blunt about what it is and what it costs.
 *
 * A tier is chosen by OpenRouter per request, on that request's own prompt.
 * A TurnShape is a sum over every request in the turn, and the sum of N
 * prompts is not a prompt - it is roughly N times one. Feeding the sum in as
 * though it were a prompt size is the tempting mistake and the expensive one:
 * a twenty-request turn of 6k prompts would be priced as a 120k prompt and
 * charged at the top tier, which over-charges by about the tool-call count.
 * That is a bigger error than the under-charge this feature exists to fix,
 * and in the same direction as flattering the developer's own bill, so it
 * would be the harder one to notice.
 *
 * So: the mean prompt, total input divided by the number of requests. Output
 * is left out because it is not in the prompt. This is exactly right for a
 * single-request turn, and exactly right for the ordinary multi-request turn
 * where every request sits in the same tier - either the conversation stayed
 * small throughout, or it crossed the threshold early and stayed above it.
 * It is wrong only for a turn that straddles a boundary partway through,
 * where it puts the whole turn on one side of it rather than splitting the
 * tokens either way. That error is bounded by the gap between two adjacent
 * tiers on part of one turn, and it can fall either way rather than always
 * favouring the same party.
 *
 * The honest alternative - keeping every request's own shape and pricing them
 * one at a time - is the right answer and a much larger change: it is the
 * shape of what the daemon records and what it sends the cockpit, not the
 * arithmetic here.
 */
export function promptPerRequest(shape: TurnShape): number | null {
  const requests = shape.requests;
  if (typeof requests !== "number" || !Number.isFinite(requests) || requests < 1) return null;
  return (shape.freshIn + shape.cacheWrite + shape.cacheRead) / requests;
}

/**
 * The rate that applies to a prompt of this size - the dearest tier the prompt
 * has reached, or the base rate when it has reached none.
 *
 * Tiers are read in ascending order rather than trusted to arrive sorted,
 * because the order is OpenRouter's to change and a mis-sorted list would
 * quietly charge the wrong rate rather than fail.
 */
export function rateForPrompt(price: Price, promptTokens: number): Rate {
  let rate: Rate = price;
  let at = -Infinity;

  for (const tier of price.tiers ?? []) {
    if (promptTokens >= tier.fromPromptTokens && tier.fromPromptTokens > at) {
      rate = tier;
      at = tier.fromPromptTokens;
    }
  }

  return rate;
}

/**
 * What this shape costs on this price, in dollars.
 *
 * Null when any part of the sum is unquoted. Not zero, and not a partial
 * total: a figure that silently leaves out output cost is worse than no
 * figure, because it looks like an answer.
 *
 * A model with no cache pricing is charged fresh for cached tokens. That is
 * what happens in practice - a model that does not cache re-reads everything
 * - so the estimate stays true rather than optimistic.
 *
 * A shape that does not say how many requests it summed is charged the base
 * rate, which is what every shape written before tiers existed gets and
 * exactly what it got yesterday. That is a deliberate choice between two
 * wrong answers: with no request count there is no way to recover a prompt
 * size, and the other guess - treat the turn as one request - over-charges a
 * long turn badly. Better to keep making the small old error than to start
 * making a large new one on a caller that has not been updated yet.
 */
export function costOfTurn(shape: TurnShape, price: Price): number | null {
  const prompt = promptPerRequest(shape);
  const rate = prompt === null ? price : rateForPrompt(price, prompt);
  if (rate.fresh === null || rate.out === null) return null;

  const cacheRead = rate.cacheRead ?? rate.fresh;
  const cacheWrite = rate.cacheWrite ?? rate.fresh;

  return (
    shape.freshIn * rate.fresh
    + shape.cacheWrite * cacheWrite
    + shape.cacheRead * cacheRead
    + shape.out * rate.out
  ) / MILLION;
}

/**
 * The cheapest and dearest this turn could come to, across every tier the
 * model has. Null when it has none, which is most of them.
 *
 * Here so the picker can say "$0.05 to $0.13" where a model's price is a range
 * rather than a point, instead of quoting one end of it as though it were the
 * answer. Nothing draws this yet - the client components are somebody else's
 * to change - but a row that quotes the headline rate for a model that charges
 * 2.67x above 128k is the exact thing this feature was opened about, so the
 * arithmetic is here and tested and ready for whoever draws it.
 *
 * Null too when the two ends are the same figure: a range of one number is not
 * a range, and "$0.05 to $0.05" is a worse way of saying $0.05.
 */
export function costSpanOfTurn(shape: TurnShape, price: Price): { low: number; high: number } | null {
  if (price.tiers === undefined || price.tiers.length === 0) return null;

  const costs = [price, ...price.tiers]
    .map((rate) => costOfTurn({ ...shape, requests: undefined }, rate))
    .filter((cost) => cost !== null);
  if (costs.length === 0) return null;

  const low = Math.min(...costs);
  const high = Math.max(...costs);
  return low === high ? null : { low, high };
}

/** The average of what actually happened. Null for nothing to average, which
 * is a cockpit that should say so rather than draw a mean of no turns. */
export function averageShape(shapes: readonly TurnShape[]): TurnShape | null {
  if (shapes.length === 0) return null;
  const add = (pick: (s: TurnShape) => number) =>
    Math.round(shapes.reduce((sum, shape) => sum + pick(shape), 0) / shapes.length);

  // Carried only when every shape counted its requests. A mean over the ones
  // that did would be a request count for a different set of turns than the
  // token figures beside it, and a tier picked off that is a tier picked off
  // arithmetic nobody performed. All or nothing is the same rule the balance
  // subtraction in credit.ts follows, for the same reason.
  const counted = shapes.every((s) => typeof s.requests === "number");

  return {
    freshIn: add((s) => s.freshIn),
    cacheWrite: add((s) => s.cacheWrite),
    cacheRead: add((s) => s.cacheRead),
    out: add((s) => s.out),
    ...(counted ? { requests: add((s) => s.requests ?? 0) } : {}),
  };
}

/** Every token a turn moved, which is the one number worth sorting shapes by. */
export function turnTokens(shape: TurnShape): number {
  return shape.freshIn + shape.cacheWrite + shape.cacheRead + shape.out;
}

/**
 * How this model compares to the one you are on, as a multiple.
 *
 * Null when either side is unpriced, or when the baseline is free - nothing
 * is a useful multiple of nothing.
 */
export function multipleOf(cost: number | null, baseline: number | null): number | null {
  if (cost === null || baseline === null || baseline <= 0) return null;
  return cost / baseline;
}

/**
 * The comparison, said the way a person would say it.
 *
 * This replaced a bare ratio - "0.25×", "1.5×" - printed beside three
 * catalogue rates and an estimate in cents. Four numbers on a row, three of
 * them expressing the same fact in units nobody converts in their head, and
 * the one that read as a saving looked exactly like the one that read as a
 * cost. "5× cheaper" cannot be misread as anything else.
 *
 * The dead band is wide on purpose. Two models within a few per cent of each
 * other are the same price for the purpose this is serving, and "1.02×
 * dearer" is a difference nobody would act on dressed as one they might.
 */
export function comparisonLabel(multiple: number | null): string {
  if (multiple === null) return "";
  if (multiple === 0) return "free";
  if (multiple >= 0.9 && multiple <= 1.1) return "about the same";

  const times = multiple < 1 ? 1 / multiple : multiple;
  const said = times >= 10 ? String(Math.round(times)) : times.toFixed(1).replace(/\.0$/, "");
  return `${said}× ${multiple < 1 ? "cheaper" : "dearer"}`;
}

/**
 * A multiple, as a bare ratio. Kept for the places that want the arithmetic
 * rather than the sentence - the saving line says both.
 */
export function multipleLabel(multiple: number | null): string {
  if (multiple === null) return "";
  // A free model is not "0.0× what you are on", which is what rounding a
  // ratio of nought produced. It is free, which is the word for it.
  if (multiple === 0) return "free";
  if (multiple >= 100) return `${Math.round(multiple)}×`;
  if (multiple >= 10) return `${multiple.toFixed(0)}×`;
  if (multiple >= 1.05) return `${multiple.toFixed(1).replace(/\.0$/, "")}×`;
  if (multiple > 0.95) return "same";
  return `${multiple.toFixed(2).replace(/0$/, "")}×`;
}

/**
 * Money, at the size it is being said.
 *
 * A turn estimate lands between a tenth of a cent and a few dollars, and the
 * same number of decimal places cannot serve both ends: $0.00 is not what a
 * cheap model costs, and $1.4213 is not a figure anybody reads.
 */
export function dollars(amount: number | null): string {
  if (amount === null) return "";
  if (amount === 0) return "free";
  if (amount < 0.01) return `${(amount * 100).toFixed(2)}¢`;
  if (amount < 1) return `${(amount * 100).toFixed(0)}¢`;
  return `$${amount.toFixed(2)}`;
}

/** Dollars per million, at the sizes a catalogue quotes them. */
export function perMillionLabel(dollars: number | null): string {
  if (dollars === null) return "—";
  if (dollars === 0) return "free";
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  // "$3.00" is a price list; "$3" is what the developer would have said.
  if (dollars < 10) return `$${dollars.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${Math.round(dollars)}`;
}

/**
 * A price that is a range, said as one - "$0.20 to $0.52".
 *
 * A sibling of the label above rather than a change to it, deliberately. That
 * one takes a single number and is called from several places that have only
 * ever had one to give; widening it would make every caller decide what to do
 * about a second figure they do not have.
 *
 * "to" rather than an en dash between two amounts that both start with a
 * dollar sign: "$0.20–$0.52" has four glyphs of punctuation in nine
 * characters and reads as one mangled figure at the size a picker row draws.
 *
 * Both ends unquoted comes out as unknown, the same as one price that is not
 * quoted, because a range between two figures nobody stated is not a range.
 */
export function perMillionSpanLabel(low: number | null, high: number | null): string {
  if (low === null && high === null) return "—";
  if (low === null || high === null || low === high) return perMillionLabel(low ?? high);
  return `${perMillionLabel(low)} to ${perMillionLabel(high)}`;
}
