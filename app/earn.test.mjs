// Worked examples for the Earn & Redeem economics.
// Run: npm run test:earn

import assert from "node:assert/strict";
import { earnFor, redeemFor, bandFor, DEFAULT_EARN_CONFIG, DEFAULT_BANDS } from "./earn.ts";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const near = (a, b, eps = 0.005) =>
  assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

console.log("earn & redeem");

t("bands match the spec table exactly", () => {
  assert.equal(bandFor(0.00, DEFAULT_BANDS).keep, 0.01);
  assert.equal(bandFor(0.119, DEFAULT_BANDS).keep, 0.01, "just under 12% is still band 1");
  assert.equal(bandFor(0.12, DEFAULT_BANDS).keep, 0.02, "12% starts band 2");
  assert.equal(bandFor(0.149, DEFAULT_BANDS).keep, 0.02);
  assert.equal(bandFor(0.15, DEFAULT_BANDS).keep, 0.03);
  assert.equal(bandFor(0.199, DEFAULT_BANDS).keep, 0.03);
  assert.equal(bandFor(0.20, DEFAULT_BANDS).keep, 0.04);
  assert.equal(bandFor(0.249, DEFAULT_BANDS).keep, 0.04);
  assert.equal(bandFor(0.25, DEFAULT_BANDS).keep, 0.05);
  assert.equal(bandFor(3.00, DEFAULT_BANDS).keep, 0.05, "no upper bound on the top band");
  assert.equal(bandFor(-0.05, DEFAULT_BANDS), null, "below cost is in no band");
  // Floating point: 10000/1.15 yields a markup of 0.14999999999999997.
  // Without a tolerance that room falls into the 12% band and is underpaid.
  const sell = 10000, cost = sell / 1.15;
  const m = (sell - cost) / cost;
  assert.ok(m < 0.15, "the computed markup really is a hair under 0.15");
  assert.equal(bandFor(m, DEFAULT_BANDS).keep, 0.03, "must still land in the 15% band");
});

t("worked example: cost 9,000 / sell 10,000 (11.1% markup, band 1)", () => {
  const r = earnFor(9000, 10000, DEFAULT_EARN_CONFIG);
  near(r.markup, 0.1111);
  near(r.margin, 0.10);
  assert.equal(r.keepRate, 0.01, "11.1% markup → 1% of sell");
  near(r.keep, 100);
  near(r.gst, 152.54);   // tax EMBEDDED in the 1,000 spread: 1000 x 0.18/1.18
  near(r.pg, 200);       // 2% of 10,000 sell
  near(r.reward, 547.46);// 1000 − 100 − 152.54 − 200
  near(r.earnPct, 0.0547);
  assert.equal(r.viable, true);
});

t("worked example: cost 8,000 / sell 10,000 (25% markup, top band)", () => {
  const r = earnFor(8000, 10000, DEFAULT_EARN_CONFIG);
  near(r.markup, 0.25);
  assert.equal(r.keepRate, 0.05, "25% markup → 5% of sell");
  near(r.keep, 500);
  near(r.gst, 305.08);   // 2000 x 0.18/1.18
  near(r.pg, 200);
  near(r.reward, 994.92);// 2000 − 500 − 305.08 − 200
  near(r.earnPct, 0.0995);
});

t("a thin-margin room cannot fund its costs and pays no reward", () => {
  // 2% markup: spread 196 on a 9,996 sell.
  // Keep ~100 + GST ~30 + gateway ~200 = ~330, well past the 196 available.
  const r = earnFor(9800, 9996, DEFAULT_EARN_CONFIG);
  assert.equal(r.viable, false);
  assert.equal(r.reward, 0, "reward is floored at zero, never negative");
  assert.ok(r.shortfall > 0, "the shortfall is surfaced, not hidden");
  assert.equal(r.earnPct, 0);
});

t("selling below cost: no band, no keep, no reward", () => {
  const r = earnFor(10500, 10000, DEFAULT_EARN_CONFIG);
  assert.equal(r.band, null);
  assert.equal(r.keep, 0);
  assert.equal(r.reward, 0);
  assert.ok(r.markup < 0);
});

t("gateway % is honoured and editable", () => {
  const base = earnFor(8000, 10000, DEFAULT_EARN_CONFIG);
  const free = earnFor(8000, 10000, { ...DEFAULT_EARN_CONFIG, pgPct: 0 });
  near(free.reward - base.reward, 200, 0.01);
});

t("GST basis can be switched from markup to keep", () => {
  const onMarkup = earnFor(8000, 10000, DEFAULT_EARN_CONFIG);
  const onKeep = earnFor(8000, 10000, { ...DEFAULT_EARN_CONFIG, gstBasis: "keep" });
  near(onMarkup.gst, 305.08);       // embedded in the 2,000 spread
  near(onKeep.gst, 76.27);          // embedded in the 500 we keep: 500 x 0.18/1.18
  assert.ok(onKeep.reward > onMarkup.reward);
});

t("GST is embedded, never added on top of the sell price", () => {
  const r = earnFor(9000, 10000, DEFAULT_EARN_CONFIG);
  // Everything paid out plus everything retained must equal the sell price.
  const accounted = r.cost + r.gst + r.keep + r.pg + r.reward;
  near(accounted, 10000, 0.01);
  // The base retained on the markup is spread / 1.18.
  near(r.spread - r.gst, 1000 / 1.18);
});

t("missing prices return null rather than a fake zero", () => {
  assert.equal(earnFor(0, 10000, DEFAULT_EARN_CONFIG), null);
  assert.equal(earnFor(9000, 0, DEFAULT_EARN_CONFIG), null);
});

t("earn % never exceeds the margin — you cannot give away more than the spread", () => {
  for (const [c, s] of [[9000, 10000], [8000, 10000], [5000, 10000], [9900, 10000]]) {
    const r = earnFor(c, s, DEFAULT_EARN_CONFIG);
    assert.ok(r.earnPct <= r.margin + 1e-9, `earn ${r.earnPct} > margin ${r.margin}`);
  }
});


// ── Redemption ──────────────────────────────────────────────────────────────
// No gateway (paying in points means no card), GST still payable, and the band
// keep IS taken — same 5% of sell as on a cash booking, both sides.

t("R1. 12% markup room, keep taken: ~₹1.076 per point", () => {
  const cost = 10000 / 1.12;                     // 8,928.57
  const r = redeemFor(cost, 10000, DEFAULT_EARN_CONFIG);
  near(r.gst, 163.44, 0.02);                     // 1,071.43 x 0.18/1.18
  near(r.keep, 200);                             // band 2 = 2% of sell, TAKEN
  assert.equal(r.pg, 0, "no gateway on a points booking");
  near(r.pointsNeeded, 9292.01, 0.05);           // cost + GST + keep
  near(r.valuePerPoint, 1.0762, 0.001);
  near(r.ceiling, 1.12, 0.001);
});

t("R2. value per point rises with markup, and only with markup", () => {
  const rows = [[0.05, 1.0313], [0.12, 1.0762], [0.15, 1.0876], [0.20, 1.1126], [0.25, 1.1357]];
  for (const [m, expected] of rows) {
    const r = redeemFor(10000 / (1 + m), 10000, DEFAULT_EARN_CONFIG);
    near(r.valuePerPoint, expected, 0.001);
  }
});

t("R3. a point can never be worth more than 1 + markup", () => {
  for (const m of [0.02, 0.05, 0.12, 0.25, 0.5]) {
    const r = redeemFor(10000 / (1 + m), 10000, DEFAULT_EARN_CONFIG);
    assert.ok(r.valuePerPoint <= r.ceiling + 1e-9,
      `value ${r.valuePerPoint} exceeded ceiling ${r.ceiling}`);
  }
});

t("R4. the ceiling needs no GST AND no keep", () => {
  const m = 0.12;
  const bare = redeemFor(10000 / (1 + m), 10000,
    { ...DEFAULT_EARN_CONFIG, redeemGst: false, redeemKeep: false });
  near(bare.valuePerPoint, 1.12, 0.0001);
  assert.equal(bare.gst, 0);
  assert.equal(bare.keep, 0);
});

t("R5. forgoing the keep raises what a point is worth", () => {
  const cost = 10000 / 1.12;
  const take = redeemFor(cost, 10000, DEFAULT_EARN_CONFIG);            // keep ON
  const give = redeemFor(cost, 10000, { ...DEFAULT_EARN_CONFIG, redeemKeep: false });
  near(take.keep, 200);
  near(take.valuePerPoint, 1.0762, 0.001);
  near(give.valuePerPoint, 1.0999, 0.001);
  assert.ok(take.valuePerPoint < give.valuePerPoint);
});

t("R6. a point always consumes exactly ₹1 of our own outlay", () => {
  // This is the property that makes redemption safe against cherry-picking:
  // whichever hotel the guest picks, our cost per point is 1.00.
  for (const m of [0.05, 0.12, 0.25]) {
    const r = redeemFor(10000 / (1 + m), 10000, DEFAULT_EARN_CONFIG);
    const ourOutlay = r.cost + r.gst + r.keep + r.pg;
    near(ourOutlay / r.pointsNeeded, 1.0, 1e-9);
  }
});

t("R6b. Roseate: the real row, keep taken on both sides", () => {
  const r = redeemFor(60165 / 3, 114858 / 3, DEFAULT_EARN_CONFIG);
  near(r.markup, 0.9091, 0.0002);
  near(r.keep, 0.05 * 114858 / 3, 0.02);         // 1,914.30 /night
  near(r.gst, 2781, 0.5);
  near(r.pointsNeeded, 74250.90 / 3, 0.05);      // 24,750.30 /night
  near(r.valuePerPoint, 1.5469, 0.001);
  assert.ok(r.valuePerPoint > 1, "still beats the ₹1 promise");
  assert.ok(r.valuePerPoint < r.ceiling, "still under 1 + markup");
});

t("R7. below-cost rooms floor at ₹1 and report what we absorb", () => {
  const r = redeemFor(10500, 10000, DEFAULT_EARN_CONFIG);
  assert.equal(r.valuePerPoint, 1, "the ₹1 promise holds");
  assert.equal(r.upliftPct, 0);
  assert.ok(r.atPar);
  near(r.shortfall, 500, 0.01);                  // we fund the gap
  assert.equal(r.pointsNeeded, 10000);
});

t("R8. missing prices return null", () => {
  assert.equal(redeemFor(0, 10000, DEFAULT_EARN_CONFIG), null);
  assert.equal(redeemFor(9000, 0, DEFAULT_EARN_CONFIG), null);
});

console.log(`\n${pass} checks passed`);
