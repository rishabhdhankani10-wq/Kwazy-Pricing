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

export function compute(inputs: Inputs): Result {
  const { tboGross, competitors, opexPct, rewardPct } = inputs;

  const valid = competitors.filter((c) => c > 0);
  const cheapestCompetitor = valid.length ? Math.min(...valid) : null;

  // ── PURCHASE LEG (TBO → us) ────────────────────────────────────────────────
  // The slab TBO charged us is set by the per-night price TBO billed.
  const tboSlab = slabForPrice(tboGross);
  const tboBase = tboGross / (1 + tboSlab.rate);
  const tboEmbeddedGst = tboGross - tboBase;

  // ITC on the PURCHASE depends on how the PURCHASE was taxed — NOT on how we
  // resell it. GST 2.0: 5% hotel slab carries NO ITC; only the 18% slab does.
  // So a room bought at <=7,500/night (5%) leaves its GST stuck in our cost,
  // even if we later sell it above 7,500.
  const itcApplies = tboSlab.itc;
  const tboRecoverableGst = itcApplies ? tboEmbeddedGst : 0;

  // True cost basis: if the input GST is creditable, our cost is the base;
  // otherwise the tax sticks and our real cost is the full gross.
  const trueCost = itcApplies ? tboBase : tboGross;
  const markupBase = trueCost;

  // ── SELL LEG (us → customer) ───────────────────────────────────────────────
  // We price to exactly match the cheapest competitor entered, so the selling
  // price is known directly (no iteration).
  //
  // Kwazy is liable for GST ONLY on the markup it adds — the room itself passes
  // through at our true cost. So the all-in selling price decomposes as:
  //     sellingPrice = trueCost + markup + (markup * sellRate)
  //   => markup = (sellingPrice - trueCost) / (1 + sellRate)
  const sellingPrice = cheapestCompetitor !== null ? cheapestCompetitor : tboGross;
  const sellSlab = slabForPrice(sellingPrice);

  // ITC case (>7,500): you reclaim TBO's GST, add markup on the base, and charge
  //   output GST on the FULL (base + markup):  S = (base + markup)(1 + r)
  //   => markup = S/(1+r) - base
  // No-ITC case (<=7,500): TBO's tax is stuck in your cost; you charge GST only
  //   on the markup you add:  S = gross + markup(1 + r)
  //   => markup = (S - gross)/(1+r)
  const markup = cheapestCompetitor !== null
    ? (itcApplies
        ? sellingPrice / (1 + sellSlab.rate) - trueCost
        : (sellingPrice - trueCost) / (1 + sellSlab.rate))
    : 0;
  const markupPct = markupBase > 0 ? markup / markupBase : 0;

  // We remit GST only on our own markup, at the output slab rate.
  const gstOnMarkup = markup * sellSlab.rate;

  // Gross profit = the markup we retain. Input GST is already handled in trueCost
  // (recovered as ITC when the purchase was >7,500; a stuck cost when <=7,500).
  const grossProfit = markup;

  const opex = sellingPrice * opexPct;
  const rewardCost = sellingPrice * rewardPct;
  const netProfit = cheapestCompetitor !== null ? grossProfit - opex - rewardCost : 0;
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
