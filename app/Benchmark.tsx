"use client";

import { useMemo, useState } from "react";
import { compute, pct } from "./engine";

// ── Default sampling frame (user can add more cities) ───────────────────────
export const CITY_BUCKETS = [
  "Goa",
  "Jaipur/Udaipur",
  "Manali/Mussoorie",
  "Lonavala/Mahabaleshwar",
  "Bengaluru (metro)",
];

export const SEASON_SLOTS = [
  { key: "jul7",  label: "~7d · mid-Jul",   tag: "monsoon off-season" },
  { key: "aug30", label: "~30d · mid-Aug",  tag: "off-season · fly window" },
  { key: "oct",   label: "mid-Oct · Diwali", tag: "peak" },
  { key: "dec",   label: "27–30 Dec",       tag: "super peak" },
  { key: "feb",   label: "mid-Feb",         tag: "shoulder" },
] as const;

export type BSlot = {
  slot: string;            // matches a SEASON_SLOTS key
  checkIn: string;         // manual
  recordedAt: string;      // auto today
  tbo: string;
  mmt: string;
  goibibo: string;
  booking: string;
  reward: string;          // per-sample reward %
  breakfast: boolean;
  freeCancellation: boolean;
  roomType: string;
};

export type BProperty = {
  id: number;
  city: string;
  name: string;
  slots: BSlot[];          // one aligned to each SEASON_SLOTS entry
};

const num = (s: string) => {
  const n = parseFloat((s || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
};

export const today = () => new Date().toISOString().slice(0, 10);

let bId = 1;
export const blankSlot = (slotKey: string): BSlot => ({
  slot: slotKey,
  checkIn: "",
  recordedAt: today(),
  tbo: "",
  mmt: "",
  goibibo: "",
  booking: "",
  reward: "",
  breakfast: false,
  freeCancellation: false,
  roomType: "",
});

export const blankProperty = (city: string, name = ""): BProperty => ({
  id: bId++,
  city,
  name,
  slots: SEASON_SLOTS.map((s) => blankSlot(s.key)),
});

// Seed: one property slot per city bucket, ready to be named.
export const seedBenchmark = (): BProperty[] =>
  CITY_BUCKETS.map((c) => blankProperty(c));

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Markup% (of cost) for one slot, using its own dynamic reward.
function slotMarkupPct(slot: BSlot, opexPct: number, globalReward: number): number | null {
  const tbo = num(slot.tbo);
  const comps = [num(slot.mmt), num(slot.goibibo), num(slot.booking)].filter((c) => c > 0);
  if (!tbo || comps.length === 0) return null;
  const rewardPct = (num(slot.reward) || globalReward) / 100;
  const res = compute({ tboGross: tbo, competitors: comps, opexPct: opexPct / 100, rewardPct });
  return res.markupPct;
}

// ── Component ───────────────────────────────────────────────────────────────
export default function Benchmark({
  benchmark,
  setBenchmark,
  opexPct,
  globalReward,
}: {
  benchmark: BProperty[];
  setBenchmark: (updater: (b: BProperty[]) => BProperty[]) => void;
  opexPct: number;
  globalReward: number;
}) {
  // ── Mutators ───────────────────────────────────────────────────────────────
  const updateSlot = (propId: number, slotKey: string, field: keyof BSlot, value: string | boolean) =>
    setBenchmark((b) =>
      b.map((p) =>
        p.id !== propId
          ? p
          : {
              ...p,
              slots: p.slots.map((s) => {
                if (s.slot !== slotKey) return s;
                const next = { ...s, [field]: value };
                // auto-stamp recorded date the moment a price is first entered
                if (field === "tbo" && value && !s.recordedAt) next.recordedAt = today();
                return next;
              }),
            }
      )
    );

  const updateProp = (propId: number, field: "name" | "city", value: string) =>
    setBenchmark((b) => b.map((p) => (p.id === propId ? { ...p, [field]: value } : p)));

  const [newCity, setNewCity] = useState("");

  const addProperty = (city: string) =>
    setBenchmark((b) => [...b, blankProperty(city)]);

  const removeProperty = (propId: number) =>
    setBenchmark((b) => b.filter((p) => p.id !== propId));

  // Cities to show = defaults ∪ any city already present in the data.
  const cities = useMemo(() => {
    const list = [...CITY_BUCKETS];
    for (const p of benchmark) if (p.city && !list.includes(p.city)) list.push(p.city);
    return list;
  }, [benchmark]);

  const addCity = () => {
    const name = newCity.trim();
    if (!name || cities.includes(name)) { setNewCity(""); return; }
    setBenchmark((b) => [...b, blankProperty(name)]); // a blank property makes the city appear
    setNewCity("");
  };

  // ── Aggregations ─────────────────────────────────────────────────────────
  const analysis = useMemo(() => {
    const perProperty = new Map<number, number | null>(); // propId -> median markup%
    for (const p of benchmark) {
      const pcts = p.slots
        .map((s) => slotMarkupPct(s, opexPct, globalReward))
        .filter((x): x is number => x !== null);
      perProperty.set(p.id, median(pcts));
    }
    const perCity = new Map<string, number | null>();
    for (const city of cities) {
      const medians = benchmark
        .filter((p) => p.city === city)
        .map((p) => perProperty.get(p.id))
        .filter((x): x is number => x != null);
      perCity.set(city, mean(medians));
    }
    const allMedians = [...perProperty.values()].filter((x): x is number => x != null);
    const overall = mean(allMedians);
    return { perProperty, perCity, overall };
  }, [benchmark, opexPct, globalReward, cities]);

  const propsByCity = (city: string) => benchmark.filter((p) => p.city === city);

  return (
    <div className="bench">
      <div className="bench-head">
        <div>
          <h2>Rate Benchmark</h2>
          <p className="bench-sub">
            Same properties, sampled across a lead-time × season grid. Median markup you can add per property, averaged across cities.
          </p>
        </div>
        <div className="bench-overall">
          <span className="bench-overall-label">Overall median markup</span>
          <span className="bench-overall-val">{analysis.overall != null ? pct(analysis.overall) : "—"}</span>
        </div>
      </div>

      <div className="bench-legend">
        {SEASON_SLOTS.map((s) => (
          <div className="bl-item" key={s.key}>
            <span className="bl-label">{s.label}</span>
            <span className="bl-tag">{s.tag}</span>
          </div>
        ))}
      </div>

      {cities.map((city) => (
        <div className="bench-city" key={city}>
          <div className="bc-head">
            <span className="bc-name">{city}</span>
            <span className="bc-avg">
              avg markup&nbsp;
              <strong>{analysis.perCity.get(city) != null ? pct(analysis.perCity.get(city)!) : "—"}</strong>
            </span>
            <button className="bc-add" onClick={() => addProperty(city)}>+ property</button>
          </div>

          {propsByCity(city).length === 0 && (
            <p className="bc-empty">No properties yet — add one to start sampling.</p>
          )}

          {propsByCity(city).map((p) => (
            <div className="bprop" key={p.id}>
              <div className="bprop-head">
                <input
                  className="bprop-name"
                  placeholder="Property name"
                  value={p.name}
                  onChange={(e) => updateProp(p.id, "name", e.target.value)}
                />
                <span className="bprop-median">
                  median&nbsp;
                  <strong>
                    {analysis.perProperty.get(p.id) != null ? pct(analysis.perProperty.get(p.id)!) : "—"}
                  </strong>
                </span>
                <button className="bprop-rm" onClick={() => removeProperty(p.id)} aria-label="Remove property">
                  &times;
                </button>
              </div>

              <div className="bslot-table">
                <div className="bslot-row bslot-header">
                  <span>Season slot</span>
                  <span>Check-in</span>
                  <span>TBO</span>
                  <span>MMT</span>
                  <span>Goibibo</span>
                  <span>Booking</span>
                  <span>Reward%</span>
                  <span>Incl.</span>
                  <span>Markup</span>
                </div>
                {SEASON_SLOTS.map((meta) => {
                  const s = p.slots.find((x) => x.slot === meta.key) ?? blankSlot(meta.key);
                  const mk = slotMarkupPct(s, opexPct, globalReward);
                  return (
                    <div className="bslot-row" key={meta.key}>
                      <span className="bslot-label">
                        {meta.label}
                        <em className="bslot-rec">rec {s.recordedAt || today()}</em>
                      </span>
                      <input
                        className="bslot-date"
                        type="date"
                        value={s.checkIn}
                        onChange={(e) => updateSlot(p.id, meta.key, "checkIn", e.target.value)}
                      />
                      <BInput value={s.tbo}     onChange={(v) => updateSlot(p.id, meta.key, "tbo", v)} />
                      <BInput value={s.mmt}     onChange={(v) => updateSlot(p.id, meta.key, "mmt", v)} />
                      <BInput value={s.goibibo} onChange={(v) => updateSlot(p.id, meta.key, "goibibo", v)} />
                      <BInput value={s.booking} onChange={(v) => updateSlot(p.id, meta.key, "booking", v)} />
                      <BInput value={s.reward}  onChange={(v) => updateSlot(p.id, meta.key, "reward", v)} placeholder={String(globalReward)} />
                      <span className="bslot-incl">
                        <label title="Breakfast included">
                          <input type="checkbox" checked={s.breakfast} onChange={(e) => updateSlot(p.id, meta.key, "breakfast", e.target.checked)} />
                          B
                        </label>
                        <label title="Free cancellation">
                          <input type="checkbox" checked={s.freeCancellation} onChange={(e) => updateSlot(p.id, meta.key, "freeCancellation", e.target.checked)} />
                          FC
                        </label>
                      </span>
                      <span className={"bslot-mk" + (mk != null && mk < 0 ? " neg" : mk != null ? " pos" : "")}>
                        {mk != null ? pct(mk) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      <div className="bench-addcity">
        <input
          className="bench-addcity-in"
          placeholder="Add a city / bucket…"
          value={newCity}
          onChange={(e) => setNewCity(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addCity(); }}
        />
        <button className="bench-addcity-btn" onClick={addCity}>+ Add city</button>
      </div>
    </div>
  );
}

function BInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="bslot-in"
      inputMode="decimal"
      value={value}
      placeholder={placeholder ?? "—"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
