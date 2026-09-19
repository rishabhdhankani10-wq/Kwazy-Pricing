// Worked examples for the Earn & Redeem economics.
// Run: npm run test:earn

import assert from "node:assert/strict";
import { earnFor, bandFor, DEFAULT_EARN_CONFIG, DEFAULT_BANDS } from "./earn.ts";

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

console.log(`\n${pass} checks passed`);
