"use client";

import { useMemo, useState } from "react";
import { compute, fmt, pct } from "./engine";
import DateRange from "./DateRange";

// ── Defaults (all user-editable at runtime) ─────────────────────────────────
export const CITY_BUCKETS = [
  "Goa",
  "Jaipur/Udaipur",
  "Manali/Mussoorie",
  "Lonavala/Mahabaleshwar",
  "Bengaluru (metro)",
];

export const DEFAULT_OTAS = ["MMT", "Goibibo", "Booking"];

export type SlotDef = { key: string; label: string; tag: string };

export const DEFAULT_SLOTS: SlotDef[] = [
  { key: "jul7",  label: "~7d · mid-Jul",   tag: "monsoon off-season" },
  { key: "aug30", label: "~30d · mid-Aug",  tag: "off-season · fly window" },
  { key: "oct",   label: "mid-Oct · Diwali", tag: "peak" },
  { key: "dec",   label: "27–30 Dec",       tag: "super peak" },
  { key: "feb",   label: "mid-Feb",         tag: "shoulder" },
];

export type BSlot = {
  slot: string;                     // matches a SlotDef key
  checkIn: string;
  checkOut: string;
  recordedAt: string;
  tbo: string;
  comps: Record<string, string>;    // OTA name -> price (stay total)
  reward: string;
  breakfast: boolean;
  freeCancellation: boolean;
  roomType: string;
};

export type BProperty = {
  id: number;
  city: string;
  name: string;
  slots: BSlot[];
};

export type BenchmarkData = {
  otas: string[];
  slots: SlotDef[];
  properties: BProperty[];
};

const num = (s: string) => {
  const n = parseFloat((s || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
};

export const today = () => new Date().toISOString().slice(0, 10);

export const slotNights = (checkIn: string, checkOut: string): number => {
  if (!checkIn || !checkOut) return 1;
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  if (isNaN(a) || isNaN(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
};

let bId = 1;

const blankSlot = (slotKey: string, otas: string[]): BSlot => ({
  slot: slotKey,
  checkIn: "",
  checkOut: "",
  recordedAt: today(),
  tbo: "",
  comps: Object.fromEntries(otas.map((o) => [o, ""])),
  reward: "",
  breakfast: false,
  freeCancellation: false,
  roomType: "",
});

const blankProperty = (city: string, otas: string[], slots: SlotDef[], name = ""): BProperty => ({
  id: bId++,
  city,
  name,
  slots: slots.map((s) => blankSlot(s.key, otas)),
});

export const seedBenchmark = (): BenchmarkData => ({
  otas: [...DEFAULT_OTAS],
  slots: [...DEFAULT_SLOTS],
  properties: CITY_BUCKETS.map((c) => blankProperty(c, DEFAULT_OTAS, DEFAULT_SLOTS)),
});

// Accepts old (BProperty[] with mmt/goibibo/booking) or new shape, always
// returns a valid BenchmarkData with comps filled for every OTA.
export function normalizeBenchmark(raw: unknown): BenchmarkData {
  if (!raw) return seedBenchmark();

  // Old shape: an array of properties with flat mmt/goibibo/booking fields.
  if (Array.isArray(raw)) {
    const otas = [...DEFAULT_OTAS];
    const slots = [...DEFAULT_SLOTS];
    const properties = (raw as unknown[]).map((pp) => {
      const p = pp as Record<string, unknown>;
      const oldSlots = (p.slots as Record<string, unknown>[]) ?? [];
      return {
        id: bId++,
        city: String(p.city ?? ""),
        name: String(p.name ?? ""),
        slots: slots.map((sd) => {
          const os = oldSlots.find((x) => x.slot === sd.key) ?? {};
          return {
            ...blankSlot(sd.key, otas),
            checkIn: String(os.checkIn ?? ""),
            checkOut: String(os.checkOut ?? ""),
            recordedAt: String(os.recordedAt ?? today()),
            tbo: String(os.tbo ?? ""),
            reward: String(os.reward ?? ""),
            breakfast: Boolean(os.breakfast),
            freeCancellation: Boolean(os.freeCancellation),
            roomType: String(os.roomType ?? ""),
            comps: {
              MMT: String(os.mmt ?? ""),
              Goibibo: String(os.goibibo ?? ""),
              Booking: String(os.booking ?? ""),
            },
          } as BSlot;
        }),
      } as BProperty;
    });
    return { otas, slots, properties };
  }

  // New shape: ensure every field exists and comps covers all OTAs.
  const d = raw as Partial<BenchmarkData>;
  const otas = d.otas && d.otas.length ? d.otas : [...DEFAULT_OTAS];
  const slots = d.slots && d.slots.length ? d.slots : [...DEFAULT_SLOTS];
  const properties = (d.properties ?? []).map((p) => ({
    id: bId++,
    city: p.city,
    name: p.name,
    slots: slots.map((sd) => {
      const existing = p.slots?.find((s) => s.slot === sd.key);
      const base = existing ?? blankSlot(sd.key, otas);
      const comps: Record<string, string> = {};
      for (const o of otas) comps[o] = base.comps?.[o] ?? "";
      return { ...blankSlot(sd.key, otas), ...base, comps };
    }),
  }));
  return { otas, slots, properties };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function slotMarkupPct(slot: BSlot, otas: string[], opexPct: number, globalReward: number): number | null {
  const nights = slotNights(slot.checkIn, slot.checkOut);
  const tbo = num(slot.tbo) / nights;
  const comps = otas
    .map((o) => num(slot.comps[o]) / nights)
    .filter((c) => c > 0);
  if (!tbo || comps.length === 0) return null;
  const rewardPct = (num(slot.reward) || globalReward) / 100;
  const res = compute({ tboGross: tbo, competitors: comps, opexPct: opexPct / 100, rewardPct });
  return res.markupPct;
}

// Agent basis: your commission = (cheapest sell − TBO), taxed 18% on the
// commission only. Retained markup as a % of TBO cost. Slab-independent.
function slotAgentMarkupPct(slot: BSlot, otas: string[]): number | null {
  const nights = slotNights(slot.checkIn, slot.checkOut);
  const tbo = num(slot.tbo) / nights;
  const comps = otas.map((o) => num(slot.comps[o]) / nights).filter((c) => c > 0);
  if (!tbo || comps.length === 0) return null;
  const sell = Math.min(...comps);
  const retained = (sell - tbo) / 1.18; // 18% GST carved out of the commission
  return retained / tbo;
}

const gridCols = (n: number) =>
  `1.4fr 1.35fr 0.9fr ${Array(n).fill("0.9fr").join(" ")} 0.7fr 0.8fr 0.75fr 0.75fr`;
const gridMinW = (n: number) => 630 + n * 105;

// ── Component ───────────────────────────────────────────────────────────────
export default function Benchmark({
  benchmark,
  setBenchmark,
  opexPct,
  globalReward,
}: {
  benchmark: BenchmarkData;
  setBenchmark: (updater: (b: BenchmarkData) => BenchmarkData) => void;
  opexPct: number;
  globalReward: number;
}) {
  const { otas, slots, properties } = benchmark;
  const [newCity, setNewCity] = useState("");
  const [newOta, setNewOta] = useState("");
  const [newSlot, setNewSlot] = useState("");

  // ── Mutators ───────────────────────────────────────────────────────────────
  const updateSlot = (propId: number, slotKey: string, field: keyof BSlot, value: string | boolean) =>
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) =>
        p.id !== propId
          ? p
          : {
              ...p,
              slots: p.slots.map((s) => {
                if (s.slot !== slotKey) return s;
                const next = { ...s, [field]: value };
                if (field === "tbo" && value && !s.recordedAt) next.recordedAt = today();
                return next;
              }),
            }
      ),
    }));

  const updateComp = (propId: number, slotKey: string, ota: string, value: string) =>
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) =>
        p.id !== propId
          ? p
          : {
              ...p,
              slots: p.slots.map((s) =>
                s.slot === slotKey ? { ...s, comps: { ...s.comps, [ota]: value } } : s
              ),
            }
      ),
    }));

  const updateSlotDates = (propId: number, slotKey: string, from: string, to: string) =>
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) =>
        p.id !== propId
          ? p
          : { ...p, slots: p.slots.map((s) => (s.slot === slotKey ? { ...s, checkIn: from, checkOut: to } : s)) }
      ),
    }));

  const updateProp = (propId: number, field: "name" | "city", value: string) =>
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) => (p.id === propId ? { ...p, [field]: value } : p)),
    }));

  const addProperty = (city: string) =>
    setBenchmark((b) => ({ ...b, properties: [...b.properties, blankProperty(city, b.otas, b.slots)] }));

  const removeProperty = (propId: number) =>
    setBenchmark((b) => ({ ...b, properties: b.properties.filter((p) => p.id !== propId) }));

  const addOta = () => {
    const name = newOta.trim();
    if (!name || otas.includes(name)) { setNewOta(""); return; }
    setBenchmark((b) => ({
      ...b,
      otas: [...b.otas, name],
      properties: b.properties.map((p) => ({
        ...p,
        slots: p.slots.map((s) => ({ ...s, comps: { ...s.comps, [name]: "" } })),
      })),
    }));
    setNewOta("");
  };

  const removeOta = (name: string) =>
    setBenchmark((b) => {
      if (b.otas.length <= 1) return b;
      return {
        ...b,
        otas: b.otas.filter((o) => o !== name),
        properties: b.properties.map((p) => ({
          ...p,
          slots: p.slots.map((s) => {
            const comps = { ...s.comps };
            delete comps[name];
            return { ...s, comps };
          }),
        })),
      };
    });

  const addSlot = () => {
    const label = newSlot.trim();
    if (!label) return;
    const def: SlotDef = { key: `slot_${Date.now()}`, label, tag: "custom" };
    setBenchmark((b) => ({
      ...b,
      slots: [...b.slots, def],
      properties: b.properties.map((p) => ({ ...p, slots: [...p.slots, blankSlot(def.key, b.otas)] })),
    }));
    setNewSlot("");
  };

  const removeSlot = (key: string) =>
    setBenchmark((b) => {
      if (b.slots.length <= 1) return b;
      return {
        ...b,
        slots: b.slots.filter((s) => s.key !== key),
        properties: b.properties.map((p) => ({ ...p, slots: p.slots.filter((s) => s.slot !== key) })),
      };
    });

  const cities = useMemo(() => {
    const list = [...CITY_BUCKETS];
    for (const p of properties) if (p.city && !list.includes(p.city)) list.push(p.city);
    return list;
  }, [properties]);

  const addCity = () => {
    const name = newCity.trim();
    if (!name || cities.includes(name)) { setNewCity(""); return; }
    setBenchmark((b) => ({ ...b, properties: [...b.properties, blankProperty(name, b.otas, b.slots)] }));
    setNewCity("");
  };

  // ── Aggregations ─────────────────────────────────────────────────────────
  const analysis = useMemo(() => {
    const perProperty = new Map<number, number | null>();
    const perPropertyA = new Map<number, number | null>();
    for (const p of properties) {
      const pcts = p.slots
        .map((s) => slotMarkupPct(s, otas, opexPct, globalReward))
        .filter((x): x is number => x !== null);
      const pctsA = p.slots
        .map((s) => slotAgentMarkupPct(s, otas))
        .filter((x): x is number => x !== null);
      perProperty.set(p.id, median(pcts));
      perPropertyA.set(p.id, median(pctsA));
    }
    const perCity = new Map<string, number | null>();
    const perCityA = new Map<string, number | null>();
    for (const city of cities) {
      const inCity = properties.filter((p) => p.city === city);
      perCity.set(city, mean(inCity.map((p) => perProperty.get(p.id)).filter((x): x is number => x != null)));
      perCityA.set(city, mean(inCity.map((p) => perPropertyA.get(p.id)).filter((x): x is number => x != null)));
    }
    const overall = mean([...perProperty.values()].filter((x): x is number => x != null));
    const overallA = mean([...perPropertyA.values()].filter((x): x is number => x != null));
    return { perProperty, perPropertyA, perCity, perCityA, overall, overallA };
  }, [properties, otas, opexPct, globalReward, cities]);

  const propsByCity = (city: string) => properties.filter((p) => p.city === city);
  const cols = gridCols(otas.length);
  const minW = gridMinW(otas.length);

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
          <span className="bench-overall-agent">agent {analysis.overallA != null ? pct(analysis.overallA) : "—"}</span>
        </div>
      </div>

      {/* OTA manager */}
      <div className="bench-config">
        <span className="bcfg-label">Compare OTAs</span>
        {otas.map((o) => (
          <span className="bcfg-chip" key={o}>
            {o}
            {otas.length > 1 && (
              <button className="bcfg-x" onClick={() => removeOta(o)} aria-label={`Remove ${o}`}>&times;</button>
            )}
          </span>
        ))}
        <input
          className="bcfg-in"
          placeholder="Add OTA…"
          value={newOta}
          onChange={(e) => setNewOta(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addOta()}
        />
        <button className="bcfg-add" onClick={addOta}>+ OTA</button>
      </div>

      {/* Slot manager */}
      <div className="bench-config">
        <span className="bcfg-label">Time slots</span>
        {slots.map((s) => (
          <span className="bcfg-chip slot" key={s.key}>
            {s.label}
            {slots.length > 1 && (
              <button className="bcfg-x" onClick={() => removeSlot(s.key)} aria-label={`Remove ${s.label}`}>&times;</button>
            )}
          </span>
        ))}
        <input
          className="bcfg-in"
          placeholder="e.g. ~60d · Sep"
          value={newSlot}
          onChange={(e) => setNewSlot(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSlot()}
        />
        <button className="bcfg-add" onClick={addSlot}>+ Slot</button>
      </div>

      {cities.map((city) => (
        <div className="bench-city" key={city}>
          <div className="bc-head">
            <span className="bc-name">{city}</span>
            <span className="bc-avg">
              avg markup&nbsp;
              <strong>{analysis.perCity.get(city) != null ? pct(analysis.perCity.get(city)!) : "—"}</strong>
              &nbsp;·&nbsp;agent&nbsp;
              <strong className="agent">{analysis.perCityA.get(city) != null ? pct(analysis.perCityA.get(city)!) : "—"}</strong>
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
                  <strong>{analysis.perProperty.get(p.id) != null ? pct(analysis.perProperty.get(p.id)!) : "—"}</strong>
                  &nbsp;·&nbsp;agent&nbsp;
                  <strong className="agent">{analysis.perPropertyA.get(p.id) != null ? pct(analysis.perPropertyA.get(p.id)!) : "—"}</strong>
                </span>
                <button className="bprop-rm" onClick={() => removeProperty(p.id)} aria-label="Remove property">&times;</button>
              </div>

              <div className="bslot-table">
                <div className="bslot-row bslot-header" style={{ gridTemplateColumns: cols, minWidth: minW }}>
                  <span>Season slot</span>
                  <span>Dates</span>
                  <span>TBO</span>
                  {otas.map((o) => (
                    <span key={o}>{o}</span>
                  ))}
                  <span>Reward%</span>
                  <span>Incl.</span>
                  <span>Markup</span>
                  <span>Agent</span>
                </div>
                {slots.map((meta) => {
                  const s = p.slots.find((x) => x.slot === meta.key) ?? blankSlot(meta.key, otas);
                  const mk = slotMarkupPct(s, otas, opexPct, globalReward);
                  const mkA = slotAgentMarkupPct(s, otas);
                  const nights = slotNights(s.checkIn, s.checkOut);
                  const perNt = num(s.tbo) && nights > 1 ? num(s.tbo) / nights : null;
                  return (
                    <div className="bslot-row" key={meta.key} style={{ gridTemplateColumns: cols, minWidth: minW }}>
                      <span className="bslot-label">
                        {meta.label}
                        <em className="bslot-rec">
                          {nights > 1 && perNt != null
                            ? `${nights} nt · ${fmt(perNt)}/nt`
                            : nights > 1
                            ? `${nights} nt`
                            : `rec ${s.recordedAt || today()}`}
                        </em>
                      </span>
                      <DateRange
                        compact
                        checkIn={s.checkIn}
                        checkOut={s.checkOut ?? ""}
                        onChange={(f, t) => updateSlotDates(p.id, meta.key, f, t)}
                      />
                      <BInput value={s.tbo} onChange={(v) => updateSlot(p.id, meta.key, "tbo", v)} />
                      {otas.map((o) => (
                        <BInput key={o} value={s.comps[o] ?? ""} onChange={(v) => updateComp(p.id, meta.key, o, v)} />
                      ))}
                      <BInput value={s.reward} onChange={(v) => updateSlot(p.id, meta.key, "reward", v)} placeholder={String(globalReward)} />
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
                      <span className={"bslot-mk agent" + (mkA != null && mkA < 0 ? " neg" : "")}>
                        {mkA != null ? pct(mkA) : "—"}
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
          onKeyDown={(e) => e.key === "Enter" && addCity()}
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
