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
}

/** US dollars per million tokens. Null is "not quoted", never zero: a model
 * whose price is decided per request must not be drawn as free. */
export interface Price {
  fresh: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  out: number | null;
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
 * What this shape costs on this price, in dollars.
 *
 * Null when any part of the sum is unquoted. Not zero, and not a partial
 * total: a figure that silently leaves out output cost is worse than no
 * figure, because it looks like an answer.
 *
 * A model with no cache pricing is charged fresh for cached tokens. That is
 * what happens in practice - a model that does not cache re-reads everything
 * - so the estimate stays true rather than optimistic.
 */
export function costOfTurn(shape: TurnShape, price: Price): number | null {
  if (price.fresh === null || price.out === null) return null;

  const cacheRead = price.cacheRead ?? price.fresh;
  const cacheWrite = price.cacheWrite ?? price.fresh;

  return (
    shape.freshIn * price.fresh
    + shape.cacheWrite * cacheWrite
    + shape.cacheRead * cacheRead
    + shape.out * price.out
  ) / MILLION;
}

/** The average of what actually happened. Null for nothing to average, which
 * is a cockpit that should say so rather than draw a mean of no turns. */
export function averageShape(shapes: readonly TurnShape[]): TurnShape | null {
  if (shapes.length === 0) return null;
  const add = (pick: (s: TurnShape) => number) =>
    Math.round(shapes.reduce((sum, shape) => sum + pick(shape), 0) / shapes.length);

  return {
    freshIn: add((s) => s.freshIn),
    cacheWrite: add((s) => s.cacheWrite),
    cacheRead: add((s) => s.cacheRead),
    out: add((s) => s.out),
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
 * A multiple, said the way people say it.
 *
 * Below one it is read as a saving and said as a fraction of what you are
 * paying now - "0.3×" is arithmetic, "a third the price" is the sentence the
 * developer was going to say to themselves anyway.
 */
export function multipleLabel(multiple: number | null): string {
  if (multiple === null) return "";
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
