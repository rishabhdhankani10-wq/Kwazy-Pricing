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
  slot: string;
  checkIn: string;
  checkOut: string;
  recordedAt: string;
  tbo: string;
  comps: Record<string, string>;    // OTA name -> price (stay total)
  reward: string;
  breakfast: boolean;
  freeCancellation: boolean;
  roomType: string;
  roveP?: string;                   // Rove price (rove board only)
  roveReturn?: string;              // Rove return %, e.g. "40"
};

export type BProperty = {
  id: number;                       // in-memory only (React keys)
  uid: string;                      // STABLE id, persisted — used to merge saves
  city: string;
  name: string;
  otas: string[];                   // per-property OTA set
  hidden: string[];                 // OTAs excluded from the result but data kept
  slots: BSlot[];
};

// Stable, collision-free id for a property. Persisted so concurrent editors can
// merge instead of overwriting each other.
export const newUid = () =>
  "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);

export type Board = {
  slots: SlotDef[];                 // time slots (per board)
  properties: BProperty[];
  usdRate?: string;                 // USD→INR rate (Rove board only)
};

export const DEFAULT_USD_RATE = "97";

// The Rove board is a second, independent board stored inside the same jsonb
// blob — so no DB migration is required.
export type BenchmarkData = Board & {
  roveBoard?: Board;
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

const blankProperty = (city: string, slots: SlotDef[], otas: string[] = DEFAULT_OTAS, name = ""): BProperty => ({
  id: bId++,
  uid: newUid(),
  city,
  name,
  otas: [...otas],
  hidden: [],
  slots: slots.map((s) => blankSlot(s.key, otas)),
});

// OTAs actually counted in the result (visible = not hidden).
const visibleOtas = (p: BProperty) => p.otas.filter((o) => !(p.hidden ?? []).includes(o));

export const seedBenchmark = (): BenchmarkData => ({
  slots: [...DEFAULT_SLOTS],
  properties: CITY_BUCKETS.map((c) => blankProperty(c, DEFAULT_SLOTS)),
  roveBoard: { slots: [...DEFAULT_SLOTS], properties: [], usdRate: DEFAULT_USD_RATE },
});

// Migrate old (BProperty[] with mmt/goibibo/booking, or object w/ global otas)
// into the new shape where each property carries its own OTA set.
export function normalizeBenchmark(raw: unknown): BenchmarkData {
  if (!raw) return seedBenchmark();

  if (Array.isArray(raw)) {
    const slots = [...DEFAULT_SLOTS];
    const otas = [...DEFAULT_OTAS];
    const properties = (raw as unknown[]).map((pp) => {
      const p = pp as Record<string, unknown>;
      const oldSlots = (p.slots as Record<string, unknown>[]) ?? [];
      return {
        id: bId++,
        uid: String(p.uid ?? newUid()),
        city: String(p.city ?? ""),
        name: String(p.name ?? ""),
        otas: [...otas],
        hidden: [],
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
            comps: { MMT: String(os.mmt ?? ""), Goibibo: String(os.goibibo ?? ""), Booking: String(os.booking ?? "") },
          } as BSlot;
        }),
      } as BProperty;
    });
    return { slots, properties, roveBoard: { slots: [...DEFAULT_SLOTS], properties: [] } };
  }

  const d = raw as Partial<BenchmarkData> & { otas?: string[] };
  const slots = d.slots && d.slots.length ? d.slots : [...DEFAULT_SLOTS];
  const globalOtas = d.otas && d.otas.length ? d.otas : [...DEFAULT_OTAS]; // old global set, if any
  const properties = (d.properties ?? []).map((p) => {
    const otas = (p as BProperty).otas?.length ? (p as BProperty).otas : globalOtas;
    return {
      id: bId++,
      uid: p.uid ?? newUid(),
      city: p.city,
      name: p.name,
      otas: [...otas],
      hidden: [...((p as BProperty).hidden ?? [])],
      slots: slots.map((sd) => {
        const existing = p.slots?.find((s) => s.slot === sd.key);
        const base = existing ?? blankSlot(sd.key, otas);
        const comps: Record<string, string> = {};
        for (const o of otas) comps[o] = base.comps?.[o] ?? "";
        return { ...blankSlot(sd.key, otas), ...base, comps };
      }),
    } as BProperty;
  });
  // Normalize the nested Rove board the same way; never drop it on load.
  const rb = d.roveBoard as Partial<Board> | undefined;
  const rSlots = rb?.slots && rb.slots.length ? rb.slots : [...DEFAULT_SLOTS];
  const rProps = (rb?.properties ?? []).map((p) => {
    const otas = p.otas?.length ? p.otas : [...DEFAULT_OTAS];
    return {
      id: bId++,
      uid: p.uid ?? newUid(),
      city: p.city,
      name: p.name,
      otas: [...otas],
      hidden: [...(p.hidden ?? [])],
      slots: rSlots.map((sd) => {
        const existing = p.slots?.find((s) => s.slot === sd.key);
        const base = existing ?? blankSlot(sd.key, otas);
        const comps: Record<string, string> = {};
        for (const o of otas) comps[o] = base.comps?.[o] ?? "";
        return { ...blankSlot(sd.key, otas), ...base, comps };
      }),
    } as BProperty;
  });

  return {
    slots,
    properties,
    roveBoard: { slots: rSlots, properties: rProps, usdRate: rb?.usdRate ?? DEFAULT_USD_RATE },
  };
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
  const comps = otas.map((o) => num(slot.comps[o]) / nights).filter((c) => c > 0);
  if (!tbo || comps.length === 0) return null;
  const rewardPct = (num(slot.reward) || globalReward) / 100;
  const res = compute({ tboGross: tbo, competitors: comps, opexPct: opexPct / 100, rewardPct });
  return res.markupPct;
}

// Agent basis: commission = (cheapest sell − TBO), taxed 18% on the commission
// only. Retained as a % of TBO cost. Slab-independent.
function slotAgentMarkupPct(slot: BSlot, otas: string[]): number | null {
  const nights = slotNights(slot.checkIn, slot.checkOut);
  const tbo = num(slot.tbo) / nights;
  const comps = otas.map((o) => num(slot.comps[o]) / nights).filter((c) => c > 0);
  if (!tbo || comps.length === 0) return null;
  const sell = Math.min(...comps);
  return ((sell - tbo) / 1.18) / tbo;
}

// Rove economics for one slot (agent basis: 18% GST on your commission only).
// Returns Rove's effective price, the reward you could afford at the cheapest
// headline, and the headroom between the two.
export function roveCalcSlot(
  s: BSlot,
  otas: string[],
  hidden: string[],
  opexPct: number,
  usdRate = Number(DEFAULT_USD_RATE)
) {
  const n = slotNights(s.checkIn, s.checkOut);
  const tbo = num(s.tbo) / n;
  // Rove prices are entered in USD; convert to INR before any comparison.
  const roveInr = num(s.roveP ?? "") * usdRate;
  const rove = roveInr / n;
  const ret = num(s.roveReturn ?? "") / 100;
  if (!tbo) return null;
  const vis = otas.filter((o) => !hidden.includes(o));
  const headlines = [...vis.map((o) => num(s.comps[o]) / n), rove].filter((x) => x > 0);
  if (!headlines.length) return null;
  const sell = Math.min(...headlines);
  const commission = (sell - tbo) / 1.18;
  // Gross of OPEX: this is the whole commission you retain, as a % of the price.
  // OPEX is deliberately NOT deducted — that call is yours.
  const maxRewardPct = commission / sell;
  // Rove's price gap vs the cheapest OTA (same reference price the Markup column
  // uses). Positive = Rove is more expensive than the OTA; negative = cheaper.
  const otaPrices = vis.map((o) => num(s.comps[o]) / n).filter((x) => x > 0);
  const otaRef = otaPrices.length ? Math.min(...otaPrices) : null;
  const roveVsOta = otaRef && rove > 0 ? (rove - otaRef) / otaRef : null;

  return {
    roveInrPerNight: rove > 0 ? rove : null,   // converted, per night
    roveEff: rove > 0 ? rove * (1 - ret) : null,
    maxRewardPct,
    headroom: rove > 0 ? maxRewardPct - ret : null,
    roveVsOta,
  };
}

const gridCols = (n: number, rove: boolean) =>
  rove
    ? `1.4fr 1.35fr 0.9fr ${Array(n).fill("0.9fr").join(" ")} 0.9fr 0.7fr 0.8fr 0.8fr 0.8fr`
    : `1.4fr 1.35fr 0.9fr ${Array(n).fill("0.9fr").join(" ")} 0.7fr 0.8fr 0.75fr 0.75fr`;
const gridMinW = (n: number, rove: boolean) => (rove ? 800 : 630) + n * 105;

// ── Component ───────────────────────────────────────────────────────────────
export default function Benchmark({
  benchmark,
  setBenchmark,
  opexPct,
  globalReward,
  roveMode = false,
  title = "Rate Benchmark",
  subtitle = "Same properties, sampled across a lead-time × season grid. Median markup you can add per property, averaged across cities.",
  onDeleteProperty,
}: {
  benchmark: Board;
  setBenchmark: (updater: (b: Board) => Board) => void;
  opexPct: number;
  globalReward: number;
  roveMode?: boolean;
  title?: string;
  subtitle?: string;
  onDeleteProperty?: (uid: string) => void;
}) {
  const { slots, properties } = benchmark;
  const usdRateNum = num(benchmark.usdRate ?? DEFAULT_USD_RATE) || Number(DEFAULT_USD_RATE);
  const [newCity, setNewCity] = useState("");
  const [newSlot, setNewSlot] = useState("");

  const mapProp = (b: Board, propId: number, fn: (p: BProperty) => BProperty) => ({
    ...b,
    properties: b.properties.map((p) => (p.id === propId ? fn(p) : p)),
  });

  const updateSlot = (propId: number, slotKey: string, field: keyof BSlot, value: string | boolean) =>
    setBenchmark((b) =>
      mapProp(b, propId, (p) => ({
        ...p,
        slots: p.slots.map((s) => {
          if (s.slot !== slotKey) return s;
          const next = { ...s, [field]: value };
          if (field === "tbo" && value && !s.recordedAt) next.recordedAt = today();
          return next;
        }),
      }))
    );

  const updateComp = (propId: number, slotKey: string, ota: string, value: string) =>
    setBenchmark((b) =>
      mapProp(b, propId, (p) => ({
        ...p,
        slots: p.slots.map((s) => (s.slot === slotKey ? { ...s, comps: { ...s.comps, [ota]: value } } : s)),
      }))
    );

  const updateSlotDates = (propId: number, slotKey: string, from: string, to: string) =>
    setBenchmark((b) =>
      mapProp(b, propId, (p) => ({
        ...p,
        slots: p.slots.map((s) => (s.slot === slotKey ? { ...s, checkIn: from, checkOut: to } : s)),
      }))
    );

  const updateProp = (propId: number, field: "name" | "city", value: string) =>
    setBenchmark((b) => mapProp(b, propId, (p) => ({ ...p, [field]: value })));

  // Copy this property's check-in/check-out dates onto the next property in the
  // same city. Dates only — prices are never touched.
  const copyDatesDown = (propId: number) =>
    setBenchmark((b) => {
      const src = b.properties.find((p) => p.id === propId);
      if (!src) return b;
      const inCity = b.properties.filter((p) => p.city === src.city);
      const idx = inCity.findIndex((p) => p.id === propId);
      const target = inCity[idx + 1];
      if (!target) return b;
      const dates = new Map(src.slots.map((s) => [s.slot, { ci: s.checkIn, co: s.checkOut }]));
      return {
        ...b,
        properties: b.properties.map((p) =>
          p.id !== target.id
            ? p
            : {
                ...p,
                slots: p.slots.map((s) => {
                  const d = dates.get(s.slot);
                  return d ? { ...s, checkIn: d.ci, checkOut: d.co } : s;
                }),
              }
        ),
      };
    });

  const addProperty = (city: string) =>
    setBenchmark((b) => ({ ...b, properties: [...b.properties, blankProperty(city, b.slots)] }));

  const removeProperty = (propId: number) =>
    setBenchmark((b) => {
      const gone = b.properties.find((p) => p.id === propId);
      if (gone?.uid) onDeleteProperty?.(gone.uid);
      return { ...b, properties: b.properties.filter((p) => p.id !== propId) };
    });

  // Per-property OTA add/remove
  const addOta = (propId: number, name: string) => {
    const nm = name.trim();
    if (!nm) return;
    setBenchmark((b) =>
      mapProp(b, propId, (p) =>
        p.otas.includes(nm)
          ? p
          : {
              ...p,
              otas: [...p.otas, nm],
              slots: p.slots.map((s) => ({ ...s, comps: { ...s.comps, [nm]: "" } })),
            }
      )
    );
  };

  // Hide/show an OTA — data is kept either way; hidden OTAs drop out of the result.
  const toggleOta = (propId: number, name: string) =>
    setBenchmark((b) =>
      mapProp(b, propId, (p) => {
        const hidden = p.hidden ?? [];
        return hidden.includes(name)
          ? { ...p, hidden: hidden.filter((o) => o !== name) }
          : { ...p, hidden: [...hidden, name] };
      })
    );

  // Global time slots
  const addSlot = () => {
    const label = newSlot.trim();
    if (!label) return;
    const def: SlotDef = { key: `slot_${Date.now()}`, label, tag: "custom" };
    setBenchmark((b) => ({
      ...b,
      slots: [...b.slots, def],
      properties: b.properties.map((p) => ({ ...p, slots: [...p.slots, blankSlot(def.key, p.otas)] })),
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
    setBenchmark((b) => ({ ...b, properties: [...b.properties, blankProperty(name, b.slots)] }));
    setNewCity("");
  };

  const analysis = useMemo(() => {
    // Raw slot-level observations per property. Every median/avg at every level
    // is computed from these directly, by pooling — so each label is the real
    // statistic (never a mean-of-medians).
    const vals = new Map<number, { p: number[]; a: number[] }>();
    for (const prop of properties) {
      const vis = visibleOtas(prop);
      const p = prop.slots
        .map((s) => slotMarkupPct(s, vis, opexPct, globalReward))
        .filter((x): x is number => x !== null);
      const a = prop.slots
        .map((s) => slotAgentMarkupPct(s, vis))
        .filter((x): x is number => x !== null);
      vals.set(prop.id, { p, a });
    }

    const perProperty = new Map<number, number | null>();
    const perPropertyA = new Map<number, number | null>();
    const perPropertyAvg = new Map<number, number | null>();
    const perPropertyAvgA = new Map<number, number | null>();
    for (const prop of properties) {
      const v = vals.get(prop.id)!;
      perProperty.set(prop.id, median(v.p));
      perPropertyA.set(prop.id, median(v.a));
      perPropertyAvg.set(prop.id, mean(v.p));
      perPropertyAvgA.set(prop.id, mean(v.a));
    }

    // City = pool every observation from that city's properties.
    const perCity = new Map<string, number | null>();
    const perCityA = new Map<string, number | null>();
    const perCityAvg = new Map<string, number | null>();
    const perCityAvgA = new Map<string, number | null>();
    for (const city of cities) {
      const inCity = properties.filter((p) => p.city === city);
      const poolP = inCity.flatMap((p) => vals.get(p.id)?.p ?? []);
      const poolA = inCity.flatMap((p) => vals.get(p.id)?.a ?? []);
      perCity.set(city, median(poolP));
      perCityA.set(city, median(poolA));
      perCityAvg.set(city, mean(poolP));
      perCityAvgA.set(city, mean(poolA));
    }

    // Overall = pool every observation everywhere.
    const allP = properties.flatMap((p) => vals.get(p.id)?.p ?? []);
    const allA = properties.flatMap((p) => vals.get(p.id)?.a ?? []);

    return {
      perProperty, perPropertyA, perPropertyAvg, perPropertyAvgA,
      perCity, perCityA, perCityAvg, perCityAvgA,
      overall: median(allP), overallA: median(allA),
      overallAvg: mean(allP), overallAvgA: mean(allA),
    };
  }, [properties, opexPct, globalReward, cities]);

  const propsByCity = (city: string) => properties.filter((p) => p.city === city);

  return (
    <div className="bench">
      <div className="bench-head">
        <div>
          <h2>{title}</h2>
          <p className="bench-sub">{subtitle}</p>
        </div>
        <div className="bench-overall">
          <span className="bench-overall-label">Overall markup · med / avg</span>
          <span className="bench-overall-val">
            {analysis.overall != null ? pct(analysis.overall) : "—"}
            <em className="bench-overall-slash"> / </em>
            {analysis.overallAvg != null ? pct(analysis.overallAvg) : "—"}
          </span>
          <span className="bench-overall-agent">
            agent {analysis.overallA != null ? pct(analysis.overallA) : "—"}
            {" / "}
            {analysis.overallAvgA != null ? pct(analysis.overallAvgA) : "—"}
          </span>
        </div>
      </div>

      {roveMode && (
        <div className="bench-config">
          <span className="bcfg-label">USD → INR</span>
          <span className="bcfg-chip">
            1 USD =&nbsp;
            <input
              className="usd-rate"
              inputMode="decimal"
              value={benchmark.usdRate ?? DEFAULT_USD_RATE}
              onChange={(e) => setBenchmark((b) => ({ ...b, usdRate: e.target.value }))}
            />
            &nbsp;INR
          </span>
          <span className="bcfg-note">Rove prices are entered in USD and converted at this rate.</span>
        </div>
      )}

      {/* Slot manager (global) */}
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
              med&nbsp;<strong>{analysis.perCity.get(city) != null ? pct(analysis.perCity.get(city)!) : "—"}</strong>
              &nbsp;·&nbsp;avg&nbsp;<strong>{analysis.perCityAvg.get(city) != null ? pct(analysis.perCityAvg.get(city)!) : "—"}</strong>
              &nbsp;·&nbsp;agent&nbsp;
              <strong className="agent">{analysis.perCityA.get(city) != null ? pct(analysis.perCityA.get(city)!) : "—"}</strong>
              <span className="agent">&nbsp;/&nbsp;</span>
              <strong className="agent">{analysis.perCityAvgA.get(city) != null ? pct(analysis.perCityAvgA.get(city)!) : "—"}</strong>
            </span>
            <button className="bc-add" onClick={() => addProperty(city)}>+ property</button>
          </div>

          {propsByCity(city).length === 0 && (
            <p className="bc-empty">No properties yet — add one to start sampling.</p>
          )}

          {propsByCity(city).map((p) => {
            const vis = visibleOtas(p);
            const cols = gridCols(vis.length, roveMode);
            const minW = gridMinW(vis.length, roveMode);
            return (
              <div className="bprop" key={p.id}>
                <div className="bprop-head">
                  <input
                    className="bprop-name"
                    placeholder="Property name"
                    value={p.name}
                    onChange={(e) => updateProp(p.id, "name", e.target.value)}
                  />
                  <span className="bprop-median">
                    med&nbsp;<strong>{analysis.perProperty.get(p.id) != null ? pct(analysis.perProperty.get(p.id)!) : "—"}</strong>
                    &nbsp;·&nbsp;avg&nbsp;<strong>{analysis.perPropertyAvg.get(p.id) != null ? pct(analysis.perPropertyAvg.get(p.id)!) : "—"}</strong>
                    &nbsp;·&nbsp;agent&nbsp;
                    <strong className="agent">{analysis.perPropertyA.get(p.id) != null ? pct(analysis.perPropertyA.get(p.id)!) : "—"}</strong>
                    <span className="agent">&nbsp;/&nbsp;</span>
                    <strong className="agent">{analysis.perPropertyAvgA.get(p.id) != null ? pct(analysis.perPropertyAvgA.get(p.id)!) : "—"}</strong>
                  </span>
                  {(() => {
                    const inCity = propsByCity(city);
                    const idx = inCity.findIndex((x) => x.id === p.id);
                    const next = inCity[idx + 1];
                    if (!next) return null;
                    return (
                      <button
                        className="copy-dates"
                        onClick={() => copyDatesDown(p.id)}
                        title={`Copy these dates to "${next.name || "the property below"}"`}
                      >
                        ↓ Copy dates
                      </button>
                    );
                  })()}
                  <button className="bprop-rm" onClick={() => removeProperty(p.id)} aria-label="Remove property">&times;</button>
                </div>

                {/* Per-property OTA manager (hide/show, non-destructive) */}
                <OtaBar otas={p.otas} hidden={p.hidden ?? []} onAdd={(nm) => addOta(p.id, nm)} onToggle={(nm) => toggleOta(p.id, nm)} />

                <div className="bslot-table">
                  <div className="bslot-row bslot-header" style={{ gridTemplateColumns: cols, minWidth: minW }}>
                    <span>Season slot</span>
                    <span>Dates</span>
                    <span>TBO</span>
                    {vis.map((o) => (
                      <span key={o}>{o}</span>
                    ))}
                    {roveMode ? (
                      <>
                        <span>Rove ($)</span>
                        <span>Return%</span>
                        <span>Markup</span>
                        <span>Agent</span>
                        <span>Rove mk</span>
                      </>
                    ) : (
                      <>
                        <span>Reward%</span>
                        <span>Incl.</span>
                        <span>Markup</span>
                        <span>Agent</span>
                      </>
                    )}
                  </div>
                  {slots.map((meta) => {
                    const s = p.slots.find((x) => x.slot === meta.key) ?? blankSlot(meta.key, p.otas);
                    const mk = slotMarkupPct(s, vis, opexPct, globalReward);
                    const mkA = slotAgentMarkupPct(s, vis);
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
                        {vis.map((o) => (
                          <BInput key={o} value={s.comps[o] ?? ""} onChange={(v) => updateComp(p.id, meta.key, o, v)} />
                        ))}
                        {roveMode ? (
                          <>
                            <span className="rove-usd">
                              <BInput value={s.roveP ?? ""} onChange={(v) => updateSlot(p.id, meta.key, "roveP", v)} />
                              {num(s.roveP ?? "") > 0 && (
                                <em className="rove-inr">= {fmt(num(s.roveP ?? "") * usdRateNum)}</em>
                              )}
                            </span>
                            <BInput value={s.roveReturn ?? ""} onChange={(v) => updateSlot(p.id, meta.key, "roveReturn", v)} placeholder="0" />
                            <span className={"bslot-mk" + (mk != null && mk < 0 ? " neg" : mk != null ? " pos" : "")}>
                              {mk != null ? pct(mk) : "—"}
                            </span>
                            <span className={"bslot-mk agent" + (mkA != null && mkA < 0 ? " neg" : "")}>
                              {mkA != null ? pct(mkA) : "—"}
                            </span>
                            {(() => {
                              const rv = roveCalcSlot(s, p.otas, p.hidden ?? [], opexPct, usdRateNum)?.roveVsOta;
                              return (
                                <span className={"bslot-mk " + (rv == null ? "" : rv >= 0 ? "pos" : "neg")}>
                                  {rv != null ? pct(rv) : "—"}
                                </span>
                              );
                            })()}
                          </>
                        ) : (
                          <>
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
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
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

function OtaBar({
  otas,
  hidden,
  onAdd,
  onToggle,
}: {
  otas: string[];
  hidden: string[];
  onAdd: (n: string) => void;
  onToggle: (n: string) => void;
}) {
  const [val, setVal] = useState("");
  const add = () => { onAdd(val); setVal(""); };
  const visibleCount = otas.filter((o) => !hidden.includes(o)).length;
  return (
    <div className="bench-config ota-bar">
      <span className="bcfg-label">OTAs</span>
      {otas.map((o) => {
        const isHidden = hidden.includes(o);
        // Prevent hiding the last visible OTA (nothing left to compare against).
        const canHide = isHidden || visibleCount > 1;
        return (
          <span className={"bcfg-chip" + (isHidden ? " ota-hidden" : "")} key={o}>
            {o}
            {canHide && (
              <button
                className="bcfg-x"
                onClick={() => onToggle(o)}
                aria-label={isHidden ? `Show ${o}` : `Hide ${o}`}
                title={isHidden ? "Add back to result" : "Subtract from result (keeps data)"}
              >
                {isHidden ? "+" : "−"}
              </button>
            )}
          </span>
        );
      })}
      <input
        className="bcfg-in"
        placeholder="Add OTA…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <button className="bcfg-add" onClick={add}>+ OTA</button>
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
