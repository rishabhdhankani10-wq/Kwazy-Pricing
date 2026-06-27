// Kwazy pricing engine
// All figures are per room-night.
//
// GST 2.0 (effective 22 Sep 2025):
//   <= 1000        : nil (0%), no ITC
//   1001 - 7500    : 5%, no ITC (mandatory; 18%-with-ITC option removed)
//   > 7500         : 18%, with ITC
// Slab is determined by VALUE OF SUPPLY = the price actually charged to the guest.

export type Slab = {
  rate: number;        // GST rate as a fraction, e.g. 0.05
  itc: boolean;        // input tax credit available
  label: string;
};

export function slabForPrice(price: number): Slab {
  if (price <= 1000) return { rate: 0, itc: false, label: "Nil (\u2264 \u20B91,000)" };
  if (price <= 7500) return { rate: 0.05, itc: false, label: "5% no ITC (\u20B91,001\u2013\u20B97,500)" };
  return { rate: 0.18, itc: true, label: "18% with ITC (> \u20B97,500)" };
}

export type Inputs = {
  tboGross: number;        // TBO price to us, tax-inclusive
  competitors: number[];   // MMT, Goibibo, Booking all-in prices (0 = not entered)
  opexPct: number;         // OPEX as fraction of GTV (selling price), e.g. 0.06
  rewardPct: number;       // reward rate the user wants to offer, fraction of selling price
};

export type Result = {
  // slab basis
  sellSlab: Slab;          // slab determined by final selling price
  tboSlab: Slab;           // slab the TBO gross falls in (for ITC decomposition)
  itcApplies: boolean;     // whether ITC applies (drives markup base)

  // costs
  trueCost: number;        // our real cost basis
  markupBase: number;      // base we add markup on
  tboBase: number;         // TBO price net of embedded GST
  tboEmbeddedGst: number;  // GST embedded in TBO gross
  tboRecoverableGst: number; // portion of embedded GST we can reclaim (ITC)

  // constraint
  cheapestCompetitor: number | null;

  // outputs at the chosen markup (max markup to hit cheapest competitor)
  markup: number;          // absolute markup amount
  markupPct: number;       // markup as % of markup base
  gstOnMarkup: number;     // GST we collect on our markup (remitted, not ours)
  sellingPrice: number;    // all-in price to customer (must be <= cheapest competitor)

  // P&L
  grossProfit: number;     // markup retained (after ITC effects)
  opex: number;            // 6% of selling price
  rewardCost: number;      // reward given to customer
  netProfit: number;       // grossProfit - opex - rewardCost
  netMarginPct: number;    // netProfit / sellingPrice

  // reward analysis
  maxRewardPct: number;    // reward rate at break-even (netProfit = 0)
  undercut: number;        // how far below cheapest competitor we sit (>=0 means we win)
};

// Compute the all-in selling price given a markup, accounting for ITC rules.
// Returns selling price and the components.
function priceFromMarkup(tboGross: number, markup: number) {
  // First guess slab from a provisional selling price to decide ITC treatment.
  // We iterate because the slab depends on the final price.
  // Start assuming markup base = tboGross (no-ITC case), refine.
  let sellingPrice = tboGross + markup; // provisional
  for (let i = 0; i < 5; i++) {
    const slab = slabForPrice(sellingPrice);
    if (slab.itc) {
      // ITC case: markup base is TBO base (net of TBO's tax), tax reclaimed.
      // We mark up on the base, then charge GST on the markup.
      const tboBase = tboGross / (1 + slab.rate);
      const newSelling = tboBase + markup + markup * slab.rate;
      if (Math.abs(newSelling - sellingPrice) < 0.001) { sellingPrice = newSelling; break; }
      sellingPrice = newSelling;
    } else {
      // No-ITC case: markup base is TBO gross (tax embedded, unrecoverable).
      const newSelling = tboGross + markup + markup * slab.rate;
      if (Math.abs(newSelling - sellingPrice) < 0.001) { sellingPrice = newSelling; break; }
      sellingPrice = newSelling;
    }
  }
  return sellingPrice;
}

// Solve for the max markup such that selling price <= target (cheapest competitor).
// Monotonic in markup, so binary search.
function solveMarkupForTarget(tboGross: number, target: number): number {
  let lo = 0;
  let hi = target; // markup can't exceed target
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const price = priceFromMarkup(tboGross, mid);
    if (price <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function compute(inputs: Inputs): Result {
  const { tboGross, competitors, opexPct, rewardPct } = inputs;

  const valid = competitors.filter((c) => c > 0);
  const cheapestCompetitor = valid.length ? Math.min(...valid) : null;

  // Determine markup: if we have a competitor, price to just match the cheapest.
  // If no competitor, default markup = 0 (user can read the floor; tool still shows P&L).
  let markup = 0;
  if (cheapestCompetitor !== null) {
    markup = solveMarkupForTarget(tboGross, cheapestCompetitor);
  }

  const sellingPrice = cheapestCompetitor !== null
    ? priceFromMarkup(tboGross, markup)
    : tboGross; // degenerate: no markup headroom known

  const sellSlab = slabForPrice(sellingPrice);
  const tboSlab = slabForPrice(tboGross);
  const itcApplies = sellSlab.itc;

  // Decompose TBO gross
  const tboBase = tboGross / (1 + tboSlab.rate);
  const tboEmbeddedGst = tboGross - tboBase;
  const tboRecoverableGst = itcApplies ? tboEmbeddedGst : 0;

  const trueCost = itcApplies ? tboBase : tboGross;
  const markupBase = trueCost;
  const markupPct = markupBase > 0 ? markup / markupBase : 0;

  const gstOnMarkup = markup * sellSlab.rate;

  // Gross profit = the markup we retain. The GST on markup is collected and remitted,
  // so it is not profit. In the ITC case the embedded TBO GST is reclaimed (washes out),
  // so trueCost already excludes it. Gross profit is simply the markup.
  const grossProfit = markup;

  const opex = sellingPrice * opexPct;
  const rewardCost = sellingPrice * rewardPct;
  const netProfit = grossProfit - opex - rewardCost;
  const netMarginPct = sellingPrice > 0 ? netProfit / sellingPrice : 0;

  // Max reward at break-even: netProfit = 0 => rewardCost = grossProfit - opex
  const maxRewardCost = Math.max(0, grossProfit - opex);
  const maxRewardPct = sellingPrice > 0 ? maxRewardCost / sellingPrice : 0;

  const undercut = cheapestCompetitor !== null ? cheapestCompetitor - sellingPrice : 0;

  return {
    sellSlab,
    tboSlab,
    itcApplies,
    trueCost,
    markupBase,
    tboBase,
    tboEmbeddedGst,
    tboRecoverableGst,
    cheapestCompetitor,
    markup,
    markupPct,
    gstOnMarkup,
    sellingPrice,
    grossProfit,
    opex,
    rewardCost,
    netProfit,
    netMarginPct,
    maxRewardPct,
    undercut,
  };
}

export const fmt = (n: number) =>
  "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
export const fmt2 = (n: number) =>
  "\u20B9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pct = (n: number) => (n * 100).toFixed(1) + "%";
