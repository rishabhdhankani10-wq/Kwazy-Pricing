"use client";

import { useMemo } from "react";
import { fmt, pct } from "./engine";
import DateRange from "./DateRange";
import type { BenchmarkData, RoveRow } from "./Benchmark";

const num = (s: string) => {
  const n = parseFloat((s || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
};

const nightsOf = (a: string, b: string) => {
  if (!a || !b) return 1;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  if (isNaN(x) || isNaN(y) || y <= x) return 1;
  return Math.max(1, Math.round((y - x) / 86_400_000));
};

let rId = 1;
export const blankRove = (): RoveRow => ({
  id: rId++, city: "", name: "", checkIn: "", checkOut: "",
  tbo: "", mmt: "", rove: "", roveReturn: "",
});

// Per-row economics, all per-night.
// Kwazy is an agent: commission = (sell − TBO) / 1.18, taxed only on the margin.
// Max reward % = the reward we could give at that price and still break even
// after OPEX.
export function roveCalc(r: RoveRow, opexPct: number) {
  const n = nightsOf(r.checkIn, r.checkOut);
  const tbo = num(r.tbo) / n;
  const mmt = num(r.mmt) / n;
  const rove = num(r.rove) / n;
  const ret = num(r.roveReturn) / 100;
  if (!tbo) return null;

  const roveEffective = rove ? rove * (1 - ret) : null;

  // Benchmark ourselves at the cheapest headline in the market.
  const headlines = [mmt, rove].filter((x) => x > 0);
  const sell = headlines.length ? Math.min(...headlines) : null;

  let commission: number | null = null;
  let maxRewardPct: number | null = null;
  if (sell) {
    commission = (sell - tbo) / 1.18;          // retained after 18% GST on margin
    const opex = sell * (opexPct / 100);
    maxRewardPct = (commission - opex) / sell; // break-even reward we can afford
  }

  // Can we match Rove's return at the same headline price?
  const headroom = maxRewardPct != null && rove ? maxRewardPct - ret : null;

  // Our effective price if we gave everything we could afford.
  const ourBest = sell != null && maxRewardPct != null ? sell * (1 - Math.max(0, maxRewardPct)) : null;

  return { n, tbo, mmt, rove, ret, roveEffective, sell, commission, maxRewardPct, headroom, ourBest };
}

export default function RoveWatch({
  benchmark,
  setBenchmark,
  opexPct,
}: {
  benchmark: BenchmarkData;
  setBenchmark: (fn: (b: BenchmarkData) => BenchmarkData) => void;
  opexPct: number;
}) {
  const rows = benchmark.rove ?? [];

  const update = (id: number, field: keyof RoveRow, value: string) =>
    setBenchmark((b) => ({
      ...b,
      rove: (b.rove ?? []).map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    }));

  const updateDates = (id: number, from: string, to: string) =>
    setBenchmark((b) => ({
      ...b,
      rove: (b.rove ?? []).map((r) => (r.id === id ? { ...r, checkIn: from, checkOut: to } : r)),
    }));

  const addRow = () => setBenchmark((b) => ({ ...b, rove: [...(b.rove ?? []), blankRove()] }));
  const removeRow = (id: number) =>
    setBenchmark((b) => ({ ...b, rove: (b.rove ?? []).filter((r) => r.id !== id) }));

  const summary = useMemo(() => {
    let beat = 0, lose = 0, n = 0;
    let sumHeadroom = 0;
    for (const r of rows) {
      const c = roveCalc(r, opexPct);
      if (!c || c.headroom == null) continue;
      n++; sumHeadroom += c.headroom;
      if (c.headroom >= 0) beat++; else lose++;
    }
    return { beat, lose, n, avgHeadroom: n ? sumHeadroom / n : null };
  }, [rows, opexPct]);

  return (
    <div className="bench">
      <div className="bench-head">
        <div>
          <h2>Rove Watch</h2>
          <p className="bench-sub">
            Rove&rsquo;s headline price minus their return is their <em>real</em> price. This compares that
            against what you could offer at the same price and still break even.
          </p>
        </div>
        <div className="bench-overall">
          <span className="bench-overall-label">Can match Rove</span>
          <span className="bench-overall-val">
            {summary.n ? `${summary.beat}/${summary.n}` : "—"}
          </span>
          <span className="bench-overall-agent">
            avg headroom {summary.avgHeadroom != null ? pct(summary.avgHeadroom) : "—"}
          </span>
        </div>
      </div>

      <div className="bench-city">
        <div className="bslot-table">
          <div className="rove-row rove-header">
            <span>City</span>
            <span>Property</span>
            <span>Dates</span>
            <span>TBO</span>
            <span>MMT</span>
            <span>Rove</span>
            <span>Return%</span>
            <span>Rove eff.</span>
            <span>Our max reward</span>
            <span>Headroom</span>
            <span></span>
          </div>

          {rows.length === 0 && (
            <p className="bc-empty">No rows yet — add one to start comparing against Rove.</p>
          )}

          {rows.map((r) => {
            const c = roveCalc(r, opexPct);
            const win = c?.headroom != null && c.headroom >= 0;
            return (
              <div className="rove-row" key={r.id}>
                <input className="bslot-in" placeholder="City" value={r.city}
                  onChange={(e) => update(r.id, "city", e.target.value)} />
                <input className="bslot-in" placeholder="Property" value={r.name}
                  onChange={(e) => update(r.id, "name", e.target.value)} />
                <DateRange compact checkIn={r.checkIn} checkOut={r.checkOut}
                  onChange={(f, t) => updateDates(r.id, f, t)} />
                <input className="bslot-in" inputMode="decimal" placeholder="—" value={r.tbo}
                  onChange={(e) => update(r.id, "tbo", e.target.value)} />
                <input className="bslot-in" inputMode="decimal" placeholder="—" value={r.mmt}
                  onChange={(e) => update(r.id, "mmt", e.target.value)} />
                <input className="bslot-in" inputMode="decimal" placeholder="—" value={r.rove}
                  onChange={(e) => update(r.id, "rove", e.target.value)} />
                <input className="bslot-in" inputMode="decimal" placeholder="0" value={r.roveReturn}
                  onChange={(e) => update(r.id, "roveReturn", e.target.value)} />
                <span className="bslot-mk">{c?.roveEffective != null ? fmt(c.roveEffective) : "—"}</span>
                <span className="bslot-mk agent">{c?.maxRewardPct != null ? pct(c.maxRewardPct) : "—"}</span>
                <span className={"bslot-mk " + (c?.headroom == null ? "" : win ? "pos" : "neg")}>
                  {c?.headroom != null ? pct(c.headroom) : "—"}
                </span>
                <button className="bprop-rm" onClick={() => removeRow(r.id)} aria-label="Remove row">&times;</button>
              </div>
            );
          })}
        </div>
        <button className="addrow" onClick={addRow}>+ Add comparison</button>
      </div>

      <footer className="foot">
        <p>
          Prices are stay totals; everything is converted to per-night. <strong>Rove eff.</strong> = Rove price
          less their return. <strong>Our max reward</strong> = the reward you could give at the cheapest
          headline price and still break even after {opexPct}% OPEX, on the agent basis (18% GST on your
          commission only). <strong>Headroom</strong> = your max reward minus Rove&rsquo;s return: positive
          means you can match or beat them, negative means you are structurally out-priced on that room.
        </p>
      </footer>
    </div>
  );
}
