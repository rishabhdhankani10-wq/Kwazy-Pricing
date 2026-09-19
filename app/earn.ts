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
//   gst     = gstPct x <basis>                      (default 18% of the markup)
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
};

export const DEFAULT_EARN_CONFIG: EarnConfig = {
  pgPct: DEFAULT_PG_PCT,
  gstPct: DEFAULT_GST_PCT,
  gstBasis: DEFAULT_GST_BASIS,
  bands: DEFAULT_BANDS,
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
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  let hit: Band | null = null;
  for (const b of sorted) {
    if (rate >= b.from) hit = b;
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
  gst: number;          // rupees
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
  const gstBase = cfg.gstBasis === "keep" ? keep : spread;
  const gst = cfg.gstPct * gstBase;

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
