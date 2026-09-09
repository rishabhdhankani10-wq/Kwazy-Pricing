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

export type CityFlags = { hideRove?: boolean; hideReturn?: boolean };

export type Board = {
  slots: SlotDef[];                 // time slots (per board)
  properties: BProperty[];
  usdRate?: string;                 // USD→INR rate (Rove board only)
  cityFlags?: Record<string, CityFlags>; // legacy per-city toggles (kept for old saves)
  hideRove?: boolean;               // board-wide: drop the Rove column everywhere
  hideReturn?: boolean;             // board-wide: drop the Return% column everywhere
};

// The retail benchmark every cost source is measured against.
export const BENCHMARK_OTA = "MMT";

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
    roveBoard: {
      slots: rSlots,
      properties: rProps,
      usdRate: rb?.usdRate ?? DEFAULT_USD_RATE,
      cityFlags: rb?.cityFlags ?? {},
      hideRove: rb?.hideRove ?? false,
      hideReturn: rb?.hideReturn ?? false,
    },
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

// ── Source-vs-benchmark economics (Rove Watch) ──────────────────────────────
// Every cost source (TBO, TripJack, anything you add) is compared against MMT,
// which is the retail benchmark. Same engine as Rate Benchmark: per-night, GST
// slabs, ITC only when BOTH legs sit above 7,500/night.
// No GST, no ITC — just the spread between what a source costs you and what MMT
// sells at, expressed two ways:
//   Markup = spread / cost   (what you add on top of what you paid)
//   Margin = spread / MMT    (what you keep out of what the customer pays)
export function sourceVsBenchmark(
  slot: BSlot,
  costRaw: string
): { markup: number; margin: number } | null {
  const n = slotNights(slot.checkIn, slot.checkOut);
  const cost = num(costRaw) / n;
  const sell = num(slot.comps[BENCHMARK_OTA] ?? "") / n;
  if (!cost || !sell) return null;
  const spread = sell - cost;
  return { markup: spread / cost, margin: spread / sell };
}

// Cost sources for a property, in display order: TBO first, then any OTA the
// user added, with the benchmark (MMT) excluded — it's the sell price, not a cost.
export const costSources = (p: BProperty) =>
  visibleOtas(p).filter((o) => o !== BENCHMARK_OTA);

// Rove layout: slot | dates | TBO | [sources] | MMT | [Rove$] | [Return%]
//              then 2 result columns (markup + agent) for TBO and each source.
const roveCols = (nSrc: number, showRove: boolean, showRet: boolean) => {
  const cols = ["1.25fr", "1.2fr", "0.85fr", ...Array(nSrc).fill("0.85fr"), "0.85fr"];
  if (showRove) cols.push("0.85fr");
  if (showRet) cols.push("0.7fr");
  return [...cols, ...Array((nSrc + 1) * 2).fill("0.8fr")].join(" ");
};
const roveMinW = (nSrc: number, showRove: boolean, showRet: boolean) =>
  430 + (nSrc + 1) * 95 + (showRove ? 95 : 0) + (showRet ? 75 : 0) + (nSrc + 1) * 2 * 86;

const gridCols = (n: number) =>
  `1.4fr 1.35fr 0.9fr ${Array(n).fill("0.9fr").join(" ")} 0.7fr 0.8fr 0.75fr 0.75fr`;
const gridMinW = (n: number) => 630 + n * 105;

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
  cityTabs = false,
}: {
  benchmark: Board;
  setBenchmark: (updater: (b: Board) => Board) => void;
  opexPct: number;
  globalReward: number;
  roveMode?: boolean;
  title?: string;
  subtitle?: string;
  onDeleteProperty?: (uid: string) => void;
  cityTabs?: boolean;
}) {
  const { slots, properties } = benchmark;
  const usdRateNum = num(benchmark.usdRate ?? DEFAULT_USD_RATE) || Number(DEFAULT_USD_RATE);
  const [newCity, setNewCity] = useState("");
  const [newSlot, setNewSlot] = useState("");
  const [activeCity, setActiveCity] = useState<string>("__all__");
  const [tabCity, setTabCity] = useState("");

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

  // ── City-wide master controls ─────────────────────────────────────────────
  // Add / hide an OTA across every property in a city at once.
  const addOtaCity = (city: string, name: string) => {
    const nm = name.trim();
    if (!nm) return;
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) =>
        p.city !== city || p.otas.includes(nm)
          ? p
          : {
              ...p,
              otas: [...p.otas, nm],
              hidden: (p.hidden ?? []).filter((h) => h !== nm),
              slots: p.slots.map((s) => ({ ...s, comps: { ...s.comps, [nm]: "" } })),
            }
      ),
    }));
  };

  const toggleOtaCity = (city: string, name: string) =>
    setBenchmark((b) => {
      const inCity = b.properties.filter((p) => p.city === city && p.otas.includes(name));
      // If it's visible anywhere in the city, hide it everywhere; otherwise show it.
      const anyVisible = inCity.some((p) => !(p.hidden ?? []).includes(name));
      return {
        ...b,
        properties: b.properties.map((p) => {
          if (p.city !== city || !p.otas.includes(name)) return p;
          const hidden = p.hidden ?? [];
          return {
            ...p,
            hidden: anyVisible
              ? hidden.includes(name) ? hidden : [...hidden, name]
              : hidden.filter((h) => h !== name),
          };
        }),
      };
    });

  // ── Board-wide (all cities) ──────────────────────────────────────────────
  const addOtaAll = (name: string) => {
    const nm = name.trim();
    if (!nm) return;
    setBenchmark((b) => ({
      ...b,
      properties: b.properties.map((p) =>
        p.otas.includes(nm)
          ? { ...p, hidden: (p.hidden ?? []).filter((h) => h !== nm) }
          : {
              ...p,
              otas: [...p.otas, nm],
              hidden: (p.hidden ?? []).filter((h) => h !== nm),
              slots: p.slots.map((s) => ({ ...s, comps: { ...s.comps, [nm]: "" } })),
            }
      ),
    }));
  };

  const toggleOtaAll = (name: string) =>
    setBenchmark((b) => {
      const anyVisible = b.properties.some((p) => p.otas.includes(name) && !(p.hidden ?? []).includes(name));
      return {
        ...b,
        properties: b.properties.map((p) => {
          if (!p.otas.includes(name)) return p;
          const hidden = p.hidden ?? [];
          return {
            ...p,
            hidden: anyVisible
              ? hidden.includes(name) ? hidden : [...hidden, name]
              : hidden.filter((h) => h !== name),
          };
        }),
      };
    });

  const toggleBoardFlag = (key: "hideRove" | "hideReturn") =>
    setBenchmark((b) => ({ ...b, [key]: !b[key] }));


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

  // ── Rove Watch: per-source stats (no tax; markup vs cost, margin vs MMT) ──
  const roveStats = useMemo(() => {
    if (!roveMode) return null;
    // Scope: the selected city tab, or every city when "All" is chosen.
    const scoped = activeCity === "__all__" ? properties : properties.filter((p) => p.city === activeCity);
    const sourceNames = ["TBO", ...[...new Set(scoped.flatMap((p) => costSources(p)))]];
    const bucket: Record<string, { mk: number[]; mg: number[] }> = {};
    for (const s of sourceNames) bucket[s] = { mk: [], mg: [] };

    // Per-property medians for every source (also used by the property header).
    const perProp = new Map<number, Record<string, { mk: number | null; mg: number | null; mkAvg: number | null; mgAvg: number | null }>>();
    // "Best of each": per PROPERTY pick its strongest source, then aggregate
    // those winners across the city — not row-by-row.
    const bestMk: number[] = [];
    const bestMg: number[] = [];

    for (const p of scoped) {
      const srcs = ["TBO", ...costSources(p)];
      const localMk: Record<string, number[]> = {};
      const localMg: Record<string, number[]> = {};
      for (const sName of srcs) { localMk[sName] = []; localMg[sName] = []; }
      for (const slot of p.slots) {
        for (const sName of srcs) {
          const raw = sName === "TBO" ? slot.tbo : (slot.comps[sName] ?? "");
          const r = sourceVsBenchmark(slot, raw);
          if (!r) continue;
          localMk[sName].push(r.markup);
          localMg[sName].push(r.margin);
        }
      }
      const rec: Record<string, { mk: number | null; mg: number | null; mkAvg: number | null; mgAvg: number | null }> = {};
      let winMk: number | null = null, winMg: number | null = null;
      for (const sName of srcs) {
        const m = median(localMk[sName]);
        const g = median(localMg[sName]);
        rec[sName] = { mk: m, mg: g, mkAvg: mean(localMk[sName]), mgAvg: mean(localMg[sName]) };
        // Every row in the summary aggregates PER PROPERTY (each hotel counted
        // once), so the source rows and "Best of each" are directly comparable.
        if (m != null) {
          bucket[sName] ??= { mk: [], mg: [] };
          bucket[sName].mk.push(m);
          if (g != null) bucket[sName].mg.push(g);
        }
        if (m != null && (winMk === null || m > winMk)) { winMk = m; winMg = g; }
      }
      perProp.set(p.id, rec);
      if (winMk !== null) { bestMk.push(winMk); if (winMg != null) bestMg.push(winMg); }
    }
    return { sourceNames, bucket, bestMk, bestMg, perProp, scope: activeCity };
  }, [roveMode, properties, activeCity]);

  return (
    <div className="bench">
      <div className="bench-head">
        <div>
          <h2>{title}</h2>
          <p className="bench-sub">{subtitle}</p>
        </div>
        {roveMode && roveStats ? (
          <div className="src-summary">
            <div className="src-row src-head">
              <span>{activeCity === "__all__" ? "All cities" : activeCity} · source → {BENCHMARK_OTA}<br /><em className="src-scope">per property</em></span>
              <span>Markup med</span>
              <span>Markup avg</span>
              <span>Margin med</span>
              <span>Margin avg</span>
            </div>
            {roveStats.sourceNames.map((s) => {
              const b = roveStats.bucket[s] ?? { mk: [], mg: [] };
              return (
                <div className="src-row" key={s}>
                  <span className="src-name">{s}</span>
                  <span>{median(b.mk) != null ? pct(median(b.mk)!) : "—"}</span>
                  <span>{mean(b.mk) != null ? pct(mean(b.mk)!) : "—"}</span>
                  <span className="agent">{median(b.mg) != null ? pct(median(b.mg)!) : "—"}</span>
                  <span className="agent">{mean(b.mg) != null ? pct(mean(b.mg)!) : "—"}</span>
                </div>
              );
            })}
            <div className="src-row src-best">
              <span className="src-name">Best of each</span>
              <span>{median(roveStats.bestMk) != null ? pct(median(roveStats.bestMk)!) : "—"}</span>
              <span>{mean(roveStats.bestMk) != null ? pct(mean(roveStats.bestMk)!) : "—"}</span>
              <span className="agent">{median(roveStats.bestMg) != null ? pct(median(roveStats.bestMg)!) : "—"}</span>
              <span className="agent">{mean(roveStats.bestMg) != null ? pct(mean(roveStats.bestMg)!) : "—"}</span>
            </div>
          </div>
        ) : (
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
        )}
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

      {roveMode && (
        <BoardMaster
          otas={[...new Set(properties.flatMap((p) => p.otas))].filter((o) => o !== BENCHMARK_OTA)}
          hiddenEverywhere={(o) =>
            properties.filter((p) => p.otas.includes(o)).every((p) => (p.hidden ?? []).includes(o))
          }
          hideRove={!!benchmark.hideRove}
          hideReturn={!!benchmark.hideReturn}
          onAdd={addOtaAll}
          onToggle={toggleOtaAll}
          onFlag={toggleBoardFlag}
        />
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

      {cityTabs && (
        <div className="city-tabs">
          <button
            className={"city-tab" + (activeCity === "__all__" ? " on" : "")}
            onClick={() => setActiveCity("__all__")}
          >
            All
            <span className="city-tab-count">{properties.length}</span>
          </button>
          {cities.map((c) => {
            const n = properties.filter((p) => p.city === c).length;
            return (
              <button
                key={c}
                className={"city-tab" + (activeCity === c ? " on" : "")}
                onClick={() => setActiveCity(c)}
              >
                {c}
                <span className="city-tab-count">{n}</span>
              </button>
            );
          })}
          <input
            className="city-tab-add"
            placeholder="+ new city"
            value={tabCity}
            onChange={(e) => setTabCity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const name = tabCity.trim();
              if (!name) return;
              if (!cities.includes(name)) {
                setBenchmark((b) => ({ ...b, properties: [...b.properties, blankProperty(name, b.slots)] }));
              }
              setActiveCity(name);
              setTabCity("");
            }}
          />
        </div>
      )}

      {(cityTabs && activeCity !== "__all__" ? cities.filter((c) => c === activeCity) : cities).map((city) => (
        <div className="bench-city" key={city}>
          <div className="bc-head">
            <span className="bc-name">{city}</span>
            {!roveMode && (
            <span className="bc-avg">
              med&nbsp;<strong>{analysis.perCity.get(city) != null ? pct(analysis.perCity.get(city)!) : "—"}</strong>
              &nbsp;·&nbsp;avg&nbsp;<strong>{analysis.perCityAvg.get(city) != null ? pct(analysis.perCityAvg.get(city)!) : "—"}</strong>
              &nbsp;·&nbsp;agent&nbsp;
              <strong className="agent">{analysis.perCityA.get(city) != null ? pct(analysis.perCityA.get(city)!) : "—"}</strong>
              <span className="agent">&nbsp;/&nbsp;</span>
              <strong className="agent">{analysis.perCityAvgA.get(city) != null ? pct(analysis.perCityAvgA.get(city)!) : "—"}</strong>
            </span>
            )}
            <button className="bc-add" onClick={() => addProperty(city)}>+ property</button>
          </div>

          {roveMode && (
            <CityMaster
              city={city}
              otas={[...new Set(propsByCity(city).flatMap((p) => p.otas))].filter((o) => o !== BENCHMARK_OTA)}
              hiddenEverywhere={(o) =>
                propsByCity(city).filter((p) => p.otas.includes(o)).every((p) => (p.hidden ?? []).includes(o))
              }
              onAdd={(nm) => addOtaCity(city, nm)}
              onToggle={(nm) => toggleOtaCity(city, nm)}
            />
          )}

          {propsByCity(city).length === 0 && (
            <p className="bc-empty">No properties yet — add one to start sampling.</p>
          )}

          {propsByCity(city).map((p) => {
            const vis = visibleOtas(p);
            const src = costSources(p);                       // TripJack, etc. (not MMT)
            const showRove = roveMode && !benchmark.hideRove;
            const showRet = roveMode && !benchmark.hideReturn;
            const cols = roveMode ? roveCols(src.length, showRove, showRet) : gridCols(vis.length);
            const minW = roveMode ? roveMinW(src.length, showRove, showRet) : gridMinW(vis.length);
            return (
              <div className="bprop" key={p.id}>
                <div className="bprop-head">
                  <input
                    className="bprop-name"
                    placeholder="Property name"
                    value={p.name}
                    onChange={(e) => updateProp(p.id, "name", e.target.value)}
                  />
                  {roveMode && roveStats ? (
                    <span className="bprop-median rove-boxes">
                      {["TBO", ...src].map((o) => {
                        const v = roveStats.perProp.get(p.id)?.[o];
                        const best = ["TBO", ...src]
                          .map((x) => roveStats.perProp.get(p.id)?.[x]?.mk)
                          .filter((x): x is number => x != null);
                        const isBest = v?.mk != null && best.length > 0 && v.mk === Math.max(...best);
                        return (
                          <span key={o} className={"src-box" + (isBest ? " best" : "")}>
                            <span className="src-box-name">{o} → {BENCHMARK_OTA}</span>
                            <span className="src-box-line">
                              <em>MK</em>
                              <strong>{v?.mk != null ? pct(v.mk) : "—"}</strong>
                              <i>med</i>
                              <strong>{v?.mkAvg != null ? pct(v.mkAvg) : "—"}</strong>
                              <i>avg</i>
                            </span>
                            <span className="src-box-line margin">
                              <em>MARGIN</em>
                              <strong>{v?.mg != null ? pct(v.mg) : "—"}</strong>
                              <i>med</i>
                              <strong>{v?.mgAvg != null ? pct(v.mgAvg) : "—"}</strong>
                              <i>avg</i>
                            </span>
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                  <span className="bprop-median">
                    med&nbsp;<strong>{analysis.perProperty.get(p.id) != null ? pct(analysis.perProperty.get(p.id)!) : "—"}</strong>
                    &nbsp;·&nbsp;avg&nbsp;<strong>{analysis.perPropertyAvg.get(p.id) != null ? pct(analysis.perPropertyAvg.get(p.id)!) : "—"}</strong>
                    &nbsp;·&nbsp;agent&nbsp;
                    <strong className="agent">{analysis.perPropertyA.get(p.id) != null ? pct(analysis.perPropertyA.get(p.id)!) : "—"}</strong>
                    <span className="agent">&nbsp;/&nbsp;</span>
                    <strong className="agent">{analysis.perPropertyAvgA.get(p.id) != null ? pct(analysis.perPropertyAvgA.get(p.id)!) : "—"}</strong>
                  </span>
                  )}
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
                    {roveMode ? (
                      <>
                        {src.map((o) => (
                          <span key={o}>{o}</span>
                        ))}
                        <span className="bench-col">{BENCHMARK_OTA}</span>
                        {showRove && <span>Rove ($)</span>}
                        {showRet && <span>Return%</span>}
                        {["TBO", ...src].map((o) => (
                          <span key={"mk" + o}>{o}→{BENCHMARK_OTA}<br />mk</span>
                        ))}
                        {["TBO", ...src].map((o) => (
                          <span key={"mg" + o} className="agent">{o}→{BENCHMARK_OTA}<br />margin</span>
                        ))}
                      </>
                    ) : (
                      vis.map((o) => <span key={o}>{o}</span>)
                    )}
                    {roveMode ? null : (
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
                        {roveMode ? (
                          <>
                            {src.map((o) => (
                              <BInput key={o} value={s.comps[o] ?? ""} onChange={(v) => updateComp(p.id, meta.key, o, v)} />
                            ))}
                            <BInput
                              value={s.comps[BENCHMARK_OTA] ?? ""}
                              onChange={(v) => updateComp(p.id, meta.key, BENCHMARK_OTA, v)}
                            />
                            {showRove && (
                              <span className="rove-usd">
                                <BInput value={s.roveP ?? ""} onChange={(v) => updateSlot(p.id, meta.key, "roveP", v)} />
                                {num(s.roveP ?? "") > 0 && (
                                  <em className="rove-inr">= {fmt(num(s.roveP ?? "") * usdRateNum)}</em>
                                )}
                              </span>
                            )}
                            {showRet && (
                              <BInput value={s.roveReturn ?? ""} onChange={(v) => updateSlot(p.id, meta.key, "roveReturn", v)} placeholder="0" />
                            )}
                            {["TBO", ...src].map((o) => {
                              const r = sourceVsBenchmark(s, o === "TBO" ? s.tbo : (s.comps[o] ?? ""));
                              return (
                                <span key={"mk" + o} className={"bslot-mk" + (r ? (r.markup < 0 ? " neg" : " pos") : "")}>
                                  {r ? pct(r.markup) : "—"}
                                </span>
                              );
                            })}
                            {["TBO", ...src].map((o) => {
                              const r = sourceVsBenchmark(s, o === "TBO" ? s.tbo : (s.comps[o] ?? ""));
                              return (
                                <span key={"mg" + o} className={"bslot-mk agent" + (r && r.margin < 0 ? " neg" : "")}>
                                  {r ? pct(r.margin) : "—"}
                                </span>
                              );
                            })}
                          </>
                        ) : (
                          <>
                          {vis.map((o) => (
                            <BInput key={o} value={s.comps[o] ?? ""} onChange={(v) => updateComp(p.id, meta.key, o, v)} />
                          ))}
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

// City-wide master: add/hide OTAs across every property in the city, and drop
// the Rove / Return% columns for the whole city at once.
function CityMaster({
  city, otas, hiddenEverywhere, onAdd, onToggle,
}: {
  city: string;
  otas: string[];
  hiddenEverywhere: (o: string) => boolean;
  onAdd: (n: string) => void;
  onToggle: (n: string) => void;
}) {
  const [val, setVal] = useState("");
  const add = () => { onAdd(val); setVal(""); };
  return (
    <div className="bench-config city-master">
      <span className="bcfg-label">All of {city}</span>
      {otas.map((o) => {
        const off = hiddenEverywhere(o);
        return (
          <span className={"bcfg-chip" + (off ? " ota-hidden" : "")} key={o}>
            {o}
            <button className="bcfg-x" onClick={() => onToggle(o)} title={off ? "Show across this city" : "Hide across this city"}>
              {off ? "+" : "−"}
            </button>
          </span>
        );
      })}
      <input
        className="bcfg-in"
        placeholder="Add OTA to whole city…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <button className="bcfg-add" onClick={add}>+ OTA</button>
    </div>
  );
}

// Board-wide master: applies to EVERY city and every property at once.
function BoardMaster({
  otas, hiddenEverywhere, hideRove, hideReturn, onAdd, onToggle, onFlag,
}: {
  otas: string[];
  hiddenEverywhere: (o: string) => boolean;
  hideRove: boolean;
  hideReturn: boolean;
  onAdd: (n: string) => void;
  onToggle: (n: string) => void;
  onFlag: (k: "hideRove" | "hideReturn") => void;
}) {
  const [val, setVal] = useState("");
  const add = () => { onAdd(val); setVal(""); };
  return (
    <div className="bench-config board-master">
      <span className="bcfg-label">All cities</span>
      {otas.map((o) => {
        const off = hiddenEverywhere(o);
        return (
          <span className={"bcfg-chip" + (off ? " ota-hidden" : "")} key={o}>
            {o}
            <button className="bcfg-x" onClick={() => onToggle(o)} title={off ? "Show everywhere" : "Hide everywhere"}>
              {off ? "+" : "−"}
            </button>
          </span>
        );
      })}
      <input
        className="bcfg-in"
        placeholder="Add OTA everywhere…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <button className="bcfg-add" onClick={add}>+ OTA</button>
      <span className="master-sep" />
      <button className={"master-toggle" + (hideRove ? " off" : "")} onClick={() => onFlag("hideRove")}>
        {hideRove ? "+ Rove" : "− Rove"}
      </button>
      <button className={"master-toggle" + (hideReturn ? " off" : "")} onClick={() => onFlag("hideReturn")}>
        {hideReturn ? "+ Return%" : "− Return%"}
      </button>
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
