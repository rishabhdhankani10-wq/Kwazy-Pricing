// Earn & Redeem economics.
//
// Per room-night:
//   cost    = TBO TotalFare
//   sell    = MMT all-in (the retail benchmark)
//   spread  = sell - cost
//   markup  = spread / cost          <- picks the band
//   margin  = spread / sell
//
//   keep    = platformMarginRate(markup) x sell     (flat % of sell, by band)
//   gst     = <basis> x gstPct/(1+gstPct)           (the tax EMBEDDED in it)
//   pg      = pgPct  x sell                         (default 2% of sell)
//   reward  = spread - keep - gst - pg              <- passed to the user
//   earnPct = reward / sell                         <- the headline "earn X% back"
//
// Every rate here is editable in the UI; the defaults below are only defaults.

export type Band = {
  /** Inclusive lower bound of the MARKUP (spread / cost), as a fraction (0.12 = 12%). */
  from: number;
  /** What we keep, as a fraction OF THE SELL PRICE (0.01 = 1% of sell). */
  keep: number;
};

/**
 * Bands on MARKUP (spread / TBO cost), per the spec table:
 * 0–12% → 1%, 12–15% → 2%, 15–20% → 3%, 20–25% → 4%, 25%+ → 5%.
 * All editable in the UI.
 */
export const DEFAULT_BANDS: Band[] = [
  { from: 0.0, keep: 0.01 },
  { from: 0.12, keep: 0.02 },
  { from: 0.15, keep: 0.03 },
  { from: 0.2, keep: 0.04 },
  { from: 0.25, keep: 0.05 },
];

export const DEFAULT_PG_PCT = 0.02;
export const DEFAULT_GST_PCT = 0.18;

/** What the GST percentage is charged on. */
export type GstBasis = "markup" | "keep";
export const DEFAULT_GST_BASIS: GstBasis = "markup";

export type EarnConfig = {
  pgPct: number;
  gstPct: number;
  gstBasis: GstBasis;
  bands: Band[];

  // ── Redemption ───────────────────────────────────────────────────────────
  /** Take the band keep on a redemption too? Default TRUE: a redemption is a
   *  booking like any other, so the same band applies on both sides. Only the
   *  REMAINDER of the markup lifts a point above ₹1. */
  redeemKeep: boolean;
  /** Gateway % on a redemption. Default 0 — paying in points means no card. */
  redeemPgPct: number;
  /** Is the markup still taxable when the consideration is points? */
  redeemGst: boolean;
};

export const DEFAULT_EARN_CONFIG: EarnConfig = {
  pgPct: DEFAULT_PG_PCT,
  gstPct: DEFAULT_GST_PCT,
  gstBasis: DEFAULT_GST_BASIS,
  bands: DEFAULT_BANDS,
  redeemKeep: true,
  redeemPgPct: 0,
  redeemGst: true,
};

/**
 * The band a rate falls into. Bands are half-open: [from, nextFrom).
 * A negative rate (selling below cost) is in no band — there is nothing to
 * keep and nothing to give away.
 *
 * Called with the MARKUP (spread / cost).
 */
export function bandFor(rate: number, bands: Band[]): Band | null {
  if (!isFinite(rate) || rate < 0) return null;
  // Tolerance matters: a room priced at exactly 15% markup computes as
  // 0.14999999999999997 in binary floating point, which would silently drop it
  // into the band below and hand it the wrong keep. Treat anything within a
  // rounding error of a boundary as being ON that boundary.
  const EPS = 1e-9;
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  let hit: Band | null = null;
  for (const b of sorted) {
    if (rate >= b.from - EPS) hit = b;
    else break;
  }
  return hit;
}

export type EarnResult = {
  cost: number;
  sell: number;
  spread: number;
  markup: number;       // spread / cost  <- selects the band
  margin: number;       // spread / sell
  band: Band | null;
  keepRate: number;     // fraction of sell we retain
  keep: number;         // rupees
  gst: number;          // rupees — the tax embedded in the basis, not added on top
  pg: number;           // rupees
  reward: number;       // rupees passed to the user (never negative)
  earnPct: number;      // reward / sell  <- the headline
  shortfall: number;    // rupees by which costs exceed the spread (0 when healthy)
  viable: boolean;      // false when the room cannot fund its own costs
};

/**
 * Compute the economics for one room-night.
 * `cost` and `sell` must already be per-night figures.
 */
export function earnFor(cost: number, sell: number, cfg: EarnConfig): EarnResult | null {
  if (!cost || !sell || cost <= 0 || sell <= 0) return null;

  const spread = sell - cost;
  const markup = spread / cost;
  const margin = spread / sell;

  const band = bandFor(markup, cfg.bands);
  const keepRate = band ? band.keep : 0;
  const keep = keepRate * sell;

  // GST is charged on the markup by default (agent model: you are taxed on the
  // value you add, not on the room). Switching the basis to "keep" taxes only
  // the fee you actually retain.
  //
  // The sell price is GST-INCLUSIVE: the customer pays MMT's price and nothing
  // more, so the tax is already sitting inside the spread rather than being
  // added on top of it. On a 1,000 markup at 18% that is
  //     1,000 x 0.18/1.18 = 152.54 of tax, leaving 847.46 of base
  // — NOT 180. Charging 180 would assume you can bill 10,180 for a 10,000 room.
  const gstBase = cfg.gstBasis === "keep" ? keep : spread;
  const gst = gstBase * (cfg.gstPct / (1 + cfg.gstPct));

  const pg = cfg.pgPct * sell;

  const raw = spread - keep - gst - pg;
  const reward = Math.max(0, raw);

  return {
    cost,
    sell,
    spread,
    markup,
    margin,
    band,
    keepRate,
    keep,
    gst,
    pg,
    reward,
    earnPct: reward / sell,
    shortfall: raw < 0 ? -raw : 0,
    viable: raw >= 0,
  };
}

export const pctStr = (n: number) => (n * 100).toFixed(1) + "%";


// ── Redemption ──────────────────────────────────────────────────────────────
//
// The guest pays in points. The room still costs you the TBO price, so you must
// collect enough points to cover that plus anything you cannot avoid paying out.
// Everything you don't need to hold back makes each point stretch further:
//
//   pointsNeeded  = cost + GST + keep [+ gateway]
//   valuePerPoint = sell / pointsNeeded
//
// Note what this means: a point always consumes exactly ₹1 of YOUR outlay, on
// every property. The uplift the guest sees is value against MMT's retail
// price, and it costs you nothing extra to hand over — which is why guests
// redeeming on your fattest inventory does not hurt you.
//
// Ceiling: valuePerPoint can never exceed sell/cost = 1 + markup. Past that you
// are funding the guest's stay.
//
// Floor: 1 point is promised to be worth at least ₹1, so the value is floored
// there and the gap you would absorb is reported as `shortfall`.

export type RedeemResult = {
  cost: number;
  sell: number;
  spread: number;
  markup: number;
  gst: number;             // rupees, embedded
  keep: number;            // rupees retained (0 unless redeemKeep)
  pg: number;              // rupees (0 unless redeemPgPct set)
  pointsNeeded: number;    // points the guest spends for this room
  valuePerPoint: number;   // rupees of room per point, floored at 1.00
  upliftPct: number;       // valuePerPoint - 1
  ceiling: number;         // 1 + markup — the most a point could ever be worth
  atPar: boolean;          // the ₹1 floor bound; you fund the gap
  shortfall: number;       // rupees absorbed when atPar
};

export function redeemFor(cost: number, sell: number, cfg: EarnConfig): RedeemResult | null {
  if (!cost || !sell || cost <= 0 || sell <= 0) return null;

  const spread = sell - cost;
  const markup = spread / cost;

  const band = bandFor(markup, cfg.bands);
  const keep = cfg.redeemKeep && band ? band.keep * sell : 0;

  const gstBase = cfg.gstBasis === "keep" ? keep : Math.max(0, spread);
  const gst = cfg.redeemGst ? gstBase * (cfg.gstPct / (1 + cfg.gstPct)) : 0;

  const pg = cfg.redeemPgPct * sell;

  const needed = cost + gst + keep + pg;
  const raw = needed > 0 ? sell / needed : 0;
  const atPar = raw < 1;

  return {
    cost,
    sell,
    spread,
    markup,
    gst,
    keep,
    pg,
    pointsNeeded: atPar ? sell : needed,
    valuePerPoint: atPar ? 1 : raw,
    upliftPct: (atPar ? 1 : raw) - 1,
    ceiling: 1 + markup,
    atPar,
    shortfall: atPar ? needed - sell : 0,
  };
}

export const rupeeStr = (n: number) => "\u20B9" + n.toFixed(3);
