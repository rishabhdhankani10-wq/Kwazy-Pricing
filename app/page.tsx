"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { compute, fmt, pct, type Result } from "./engine";
import Benchmark, { type BProperty, seedBenchmark } from "./Benchmark";

type CostMode = "night" | "total";
type View = "desk" | "benchmark";

type Row = {
  id: number;
  hotel: string;
  tbo: string;
  mmt: string;
  goibibo: string;
  booking: string;
  checkIn: string;   // ISO date string, optional
  nights: string;    // number of nights (default "1")
  mode: CostMode;    // are the prices entered per-night or for the whole stay
  reward: string;    // per-row reward override (%) — blank = use global
};

type HotelRecord = {
  id: string;
  hotel_name: string;
  tbo_gross: number;
  tbo_base: number;
  tbo_gst: number;
  tbo_slab_label: string;
  itc_applies: boolean;
  mmt: number | null;
  goibibo: number | null;
  booking: number | null;
  sell_price: number | null;
  markup: number | null;
  net_profit: number | null;
  net_margin_pct: number | null;
  check_in: string | null;
  nights: number | null;
  cost_mode: string | null;
  updated_at: string;
};

type SaveStatus = "idle" | "saving" | "saved" | "error";
type PortfolioTab = "hotel" | "blended";

let nextId = 1;
const blankRow = (): Row => ({
  id: nextId++,
  hotel: "",
  tbo: "",
  mmt: "",
  goibibo: "",
  booking: "",
  checkIn: "",
  nights: "1",
  mode: "night",
  reward: "",
});

const num = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
};

const nightsOf = (r: Row) => Math.max(1, Math.round(num(r.nights) || 1));

// Convert a raw entered price to a per-night figure based on the row's mode.
const toNight = (raw: number, r: Row) => (r.mode === "total" ? raw / nightsOf(r) : raw);

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

export default function Page() {
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [opexPct, setOpexPct] = useState(6);
  const [rewardPct, setRewardPct] = useState(2);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [history, setHistory] = useState<HotelRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const [portfolioTab, setPortfolioTab] = useState<PortfolioTab>("hotel");
  const [view, setView] = useState<View>("desk");
  const [benchmark, setBenchmark] = useState<BProperty[]>(seedBenchmark);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hotelDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);

  // ── Load last session on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.rows && data.rows.length > 0) {
          const loaded: Row[] = data.rows.map((r: Partial<Row>) => ({
            ...blankRow(),
            ...r,
            id: nextId++,
            // backfill fields that may not exist in older saves
            checkIn: r.checkIn ?? "",
            nights: r.nights ?? "1",
            mode: (r.mode as CostMode) ?? "night",
            reward: r.reward ?? "",
          }));
          setRows(loaded);
          if (data.opex_pct != null) setOpexPct(Number(data.opex_pct));
          if (data.reward_pct != null) setRewardPct(Number(data.reward_pct));
        }
        if (data && Array.isArray(data.benchmark) && data.benchmark.length > 0) {
          setBenchmark(data.benchmark);
        }
        setSessionLoaded(true);
      })
      .catch(() => setSessionLoaded(true));
  }, []);

  // ── Auto-select first row with data ────────────────────────────────────────
  useEffect(() => {
    if (selectedRowId === null) {
      const first = rows.find((r) => num(r.tbo) > 0);
      if (first) setSelectedRowId(first.id);
    }
  }, [rows, selectedRowId]);

  // ── Load hotel history ──────────────────────────────────────────────────────
  const loadHistory = useCallback(() => {
    fetch("/api/hotels")
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setHistory(data))
      .catch(() => {});
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Auto-save board state (debounced 1.5s) ──────────────────────────────────
  const saveSession = useCallback(
    (currentRows: Row[], currentOpex: number, currentReward: number, currentBenchmark: BProperty[]) => {
      setSaveStatus("saving");
      fetch("/api/session", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: currentRows, opex_pct: currentOpex, reward_pct: currentReward, benchmark: currentBenchmark }),
      })
        .then((r) => (r.ok ? setSaveStatus("saved") : setSaveStatus("error")))
        .catch(() => setSaveStatus("error"))
        .finally(() => setTimeout(() => setSaveStatus("idle"), 2000));
    },
    []
  );

  // ── Auto-save individual hotels (debounced 2s) ──────────────────────────────
  const saveHotels = useCallback((currentRows: Row[], computedRes: Result[]) => {
    currentRows.forEach((row, i) => {
      if (!row.hotel.trim() || !num(row.tbo)) return;
      const res = computedRes[i];
      const n = nightsOf(row);
      fetch("/api/hotels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotel_name: row.hotel.trim(),
          // stored normalized to PER-NIGHT so history is comparable
          tbo_gross: toNight(num(row.tbo), row),
          tbo_base: res.tboBase,
          tbo_gst: res.tboEmbeddedGst,
          tbo_slab_label: res.tboSlab.label,
          itc_applies: res.itcApplies,
          mmt: num(row.mmt) ? toNight(num(row.mmt), row) : null,
          goibibo: num(row.goibibo) ? toNight(num(row.goibibo), row) : null,
          booking: num(row.booking) ? toNight(num(row.booking), row) : null,
          sell_price: res.cheapestCompetitor !== null ? res.sellingPrice : null,
          markup: res.cheapestCompetitor !== null ? res.markup : null,
          net_profit: res.cheapestCompetitor !== null ? res.netProfit : null,
          net_margin_pct: res.cheapestCompetitor !== null ? res.netMarginPct : null,
          check_in: row.checkIn || null,
          nights: n,
          cost_mode: row.mode,
        }),
      }).catch(() => {});
    });
  }, []);

  // ── Computed results (engine always works per-night) ────────────────────────
  const computedResults = useMemo(
    () =>
      rows.map((r) =>
        compute({
          tboGross: toNight(num(r.tbo), r),
          competitors: [toNight(num(r.mmt), r), toNight(num(r.goibibo), r), toNight(num(r.booking), r)],
          opexPct: opexPct / 100,
          rewardPct: (num(r.reward) || rewardPct) / 100, // per-row reward override
        })
      ),
    [rows, opexPct, rewardPct]
  );

  // ── Trigger saves on state changes ─────────────────────────────────────────
  useEffect(() => {
    if (!sessionLoaded) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveSession(rows, opexPct, rewardPct, benchmark), 1500);
    if (hotelDebounceRef.current) clearTimeout(hotelDebounceRef.current);
    hotelDebounceRef.current = setTimeout(() => { saveHotels(rows, computedResults); loadHistory(); }, 2000);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (hotelDebounceRef.current) clearTimeout(hotelDebounceRef.current);
    };
  }, [rows, opexPct, rewardPct, benchmark, sessionLoaded, saveSession, saveHotels, computedResults, loadHistory]);

  // ── Row operations ──────────────────────────────────────────────────────────
  const update = (id: number, field: keyof Row, value: string) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const setMode = (id: number, mode: CostMode) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, mode } : r)));
  const addRow = () => { const r = blankRow(); setRows((rs) => [...rs, r]); setSelectedRowId(r.id); };
  const removeRow = (id: number) => {
    setRows((rs) => {
      if (rs.length <= 1) return rs;
      const next = rs.filter((r) => r.id !== id);
      if (selectedRowId === id) setSelectedRowId(next[0]?.id ?? null);
      return next;
    });
  };

  // ── Load hotel from history into ledger ─────────────────────────────────────
  const loadFromHistory = useCallback((h: HotelRecord) => {
    const r = blankRow();
    r.hotel   = h.hotel_name;
    r.tbo     = String(h.tbo_gross);
    r.mmt     = h.mmt     ? String(h.mmt)     : "";
    r.goibibo = h.goibibo ? String(h.goibibo) : "";
    r.booking = h.booking ? String(h.booking) : "";
    r.checkIn = h.check_in ?? "";
    r.nights  = h.nights ? String(h.nights) : "1";
    r.mode    = "night"; // history is stored per-night
    setRows((rs) => [r, ...rs]);
    setSelectedRowId(r.id);
    setPortfolioTab("hotel");
    setShowHistory(false);
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const results = useMemo(
    () => rows.map((r, i) => ({ row: r, res: computedResults[i] })),
    [rows, computedResults]
  );

  const selectedEntry = useMemo(
    () => results.find(({ row }) => row.id === selectedRowId) ?? null,
    [results, selectedRowId]
  );

  const totals = useMemo(() => {
    let gtv = 0, gp = 0, opex = 0, reward = 0, net = 0, n = 0;
    for (const { res, row } of results) {
      if (num(row.tbo) > 0 && res.cheapestCompetitor !== null) {
        const nights = nightsOf(row); // scale per-night engine output to the whole stay
        gtv += res.sellingPrice * nights; gp += res.grossProfit * nights;
        opex += res.opex * nights; reward += res.rewardCost * nights; net += res.netProfit * nights; n++;
      }
    }
    return { gtv, gp, opex, reward, net, n };
  }, [results]);

  const filteredHistory = useMemo(() => {
    if (!historySearch.trim()) return history;
    const q = historySearch.toLowerCase();
    return history.filter((h) => h.hotel_name.toLowerCase().includes(q));
  }, [history, historySearch]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <header className="masthead">
        <div className="mark"><span className="mark-k">K</span></div>
        <div style={{ flex: 1 }}>
          <h1>Kwazy Pricing Desk</h1>
          <p className="sub">TBO cost vs. competitor retail. Solve for max markup, reward rate, and margin per room-night.</p>
        </div>
        <div className="save-status" data-status={saveStatus}>
          {saveStatus === "saving" && <><span className="save-dot saving" />Saving…</>}
          {saveStatus === "saved"  && <><span className="save-dot saved"  />Saved</>}
          {saveStatus === "error"  && <><span className="save-dot error"  />Save failed</>}
        </div>
      </header>

      <nav className="view-nav">
        <button className={"view-tab" + (view === "desk" ? " on" : "")} onClick={() => setView("desk")}>Pricing Desk</button>
        <button className={"view-tab" + (view === "benchmark" ? " on" : "")} onClick={() => setView("benchmark")}>Rate Benchmark</button>
      </nav>

      {view === "benchmark" && (
        <Benchmark benchmark={benchmark} setBenchmark={setBenchmark} opexPct={opexPct} globalReward={rewardPct} />
      )}

      {view === "desk" && (<>
      <section className="controls">
        <label className="ctrl">
          <span className="ctrl-label">OPEX (% of GTV)</span>
          <div className="ctrl-input">
            <input type="number" value={opexPct} step={0.5} onChange={(e) => setOpexPct(num(e.target.value))} />
            <span className="unit">%</span>
          </div>
        </label>
        <label className="ctrl">
          <span className="ctrl-label">Reward rate offered (% of GTV)</span>
          <div className="ctrl-input">
            <input type="number" value={rewardPct} step={0.25} onChange={(e) => setRewardPct(num(e.target.value))} />
            <span className="unit">%</span>
          </div>
        </label>
        <div className="ctrl note">Slab set by per-night selling price &middot; &le;&#8377;1k nil &middot; &le;&#8377;7.5k 5% no&nbsp;ITC &middot; &gt;&#8377;7.5k 18% +ITC</div>
      </section>

      {/* ── Ledger ────────────────────────────────────────────────────────── */}
      <div className="ledger" ref={ledgerRef}>
        <div className="lhead">
          <div className="lh hotel">Hotel &amp; dates</div>
          <div className="lh group cost">
            <span className="grp-title">Supplier</span>
            <div className="grp-cells"><span>TBO → base + GST</span></div>
          </div>
          <div className="lh group comp">
            <span className="grp-title">Competitor</span>
            <div className="grp-cells three"><span>MMT</span><span>Goibibo</span><span>Booking</span></div>
          </div>
          <div className="lh group out">
            <span className="grp-title">Result (per night)</span>
            <div className="grp-cells out-cells">
              <span>Sell @</span><span>Markup</span><span>GST</span><span>Net profit</span><span>Margin</span><span>Max reward</span>
            </div>
          </div>
          <div className="lh act"></div>
        </div>

        {results.map(({ row, res }) => {
          const hasCost = num(row.tbo) > 0;
          const hasComp = res.cheapestCompetitor !== null;
          const live = hasCost && hasComp;
          const loss = live && res.netProfit < 0;
          const rewardExceedsMax = live && rewardPct / 100 > res.maxRewardPct + 1e-9;
          const isSelected = row.id === selectedRowId;
          const n = nightsOf(row);
          const perNightTbo = toNight(num(row.tbo), row);
          return (
            <div
              className={"lrow" + (isSelected ? " lrow-selected" : "")}
              key={row.id}
              onClick={() => { setSelectedRowId(row.id); setPortfolioTab("hotel"); }}
            >
              <div className="cell hotel">
                <input
                  className="hotel-in"
                  placeholder="Name / city"
                  value={row.hotel}
                  onChange={(e) => update(row.id, "hotel", e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="date-nights" onClick={(e) => e.stopPropagation()}>
                  <input
                    className="date-in"
                    type="date"
                    value={row.checkIn}
                    onChange={(e) => update(row.id, "checkIn", e.target.value)}
                    title="Check-in date"
                  />
                  <div className="nights-in">
                    <input
                      inputMode="numeric"
                      value={row.nights}
                      onChange={(e) => update(row.id, "nights", e.target.value)}
                      title="Number of nights"
                    />
                    <span>nt</span>
                  </div>
                  <div className="nights-in reward-in">
                    <input
                      inputMode="decimal"
                      value={row.reward}
                      placeholder={String(rewardPct)}
                      onChange={(e) => update(row.id, "reward", e.target.value)}
                      title="Reward % for this room (blank = global)"
                    />
                    <span>rwd%</span>
                  </div>
                </div>
                {hasCost && (
                  <span className="slab-tag" data-itc={res.itcApplies}>
                    sell {pct(res.sellSlab.rate)} &middot; {res.itcApplies ? "input ITC ✓" : "5% stuck"}
                  </span>
                )}
              </div>

              <div className="cell cost" onClick={(e) => e.stopPropagation()}>
                <div className="mode-toggle">
                  <button className={row.mode === "night" ? "on" : ""} onClick={() => setMode(row.id, "night")}>Per night</button>
                  <button className={row.mode === "total" ? "on" : ""} onClick={() => setMode(row.id, "total")}>Total stay</button>
                </div>
                <NumCell value={row.tbo} onChange={(v) => update(row.id, "tbo", v)} placeholder="0" />
                {hasCost && (
                  <div className="tbo-breakdown">
                    {row.mode === "total" && n > 1 && (
                      <div className="tbo-br-row derived">
                        <span className="tbo-br-label">÷ {n} nights</span>
                        <span className="tbo-br-val">{fmt(perNightTbo)}/nt</span>
                      </div>
                    )}
                    <div className="tbo-br-row">
                      <span className="tbo-br-label">Base</span>
                      <span className="tbo-br-val">{fmt(res.tboBase)}</span>
                    </div>
                    <div className="tbo-br-row">
                      <span className="tbo-br-label">
                        GST {pct(res.tboSlab.rate)}
                        {res.tboSlab.rate > 0 && (
                          <em className={"tbo-br-itc" + (res.itcApplies ? " recoverable" : "")}>
                            {res.itcApplies ? " ITC" : " no ITC"}
                          </em>
                        )}
                      </span>
                      <span className="tbo-br-val dim">{fmt(res.tboEmbeddedGst)}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="cell comp three" onClick={(e) => e.stopPropagation()}>
                <NumCell value={row.mmt}     onChange={(v) => update(row.id, "mmt", v)}     placeholder="&mdash;" muted={res.cheapestCompetitor !== toNight(num(row.mmt), row)     || !num(row.mmt)} />
                <NumCell value={row.goibibo} onChange={(v) => update(row.id, "goibibo", v)} placeholder="&mdash;" muted={res.cheapestCompetitor !== toNight(num(row.goibibo), row) || !num(row.goibibo)} />
                <NumCell value={row.booking} onChange={(v) => update(row.id, "booking", v)} placeholder="&mdash;" muted={res.cheapestCompetitor !== toNight(num(row.booking), row) || !num(row.booking)} />
              </div>

              <div className="cell out out-cells">
                <span className="v strong">{live ? fmt(res.sellingPrice) : "—"}</span>
                <span className="v">{live ? fmt(res.markup) : "—"}{live && <em className="vsub">{pct(res.markupPct)}</em>}</span>
                <span className="v dim">{live ? fmt(res.gstOnMarkup) : "—"}</span>
                <span className={"v strong " + (loss ? "neg" : "pos")}>{live ? fmt(res.netProfit) : "—"}</span>
                <span className={"v " + (loss ? "neg" : "")}>{live ? pct(res.netMarginPct) : "—"}</span>
                <span className="v dim">{live ? pct(res.maxRewardPct) : "—"}{rewardExceedsMax && <em className="warn-dot" title="Reward set above break-even">!</em>}</span>
              </div>

              <div className="cell act">
                <button className="rm" onClick={(e) => { e.stopPropagation(); removeRow(row.id); }} aria-label="Remove row">&times;</button>
              </div>
            </div>
          );
        })}

        <button className="addrow" onClick={addRow}>+ Add hotel</button>
      </div>

      {/* ── Portfolio / Detail section ─────────────────────────────────────── */}
      {(selectedEntry || totals.n > 0) && (
        <section className="portfolio-section">
          <div className="portfolio-tabs">
            <button
              className={"ptab" + (portfolioTab === "hotel" ? " ptab-active" : "")}
              onClick={() => setPortfolioTab("hotel")}
            >
              {selectedEntry?.row.hotel || "Current hotel"}
            </button>
            <button
              className={"ptab" + (portfolioTab === "blended" ? " ptab-active" : "")}
              onClick={() => setPortfolioTab("blended")}
            >
              Blended&nbsp;<span className="ptab-count">({totals.n} hotel{totals.n !== 1 ? "s" : ""})</span>
            </button>
          </div>

          {portfolioTab === "hotel" && selectedEntry && (
            <HotelDetail row={selectedEntry.row} res={selectedEntry.res} opexPct={opexPct} rewardPct={rewardPct} />
          )}

          {portfolioTab === "blended" && totals.n > 0 && (
            <div className="blended-body">
              <div className="tgrid">
                <Tot label="GTV (stay totals)"      value={fmt(totals.gtv)} />
                <Tot label="Gross profit (markup)"  value={fmt(totals.gp)} />
                <Tot label="OPEX"                   value={"−" + fmt(totals.opex)} />
                <Tot label="Reward given"           value={"−" + fmt(totals.reward)} />
                <Tot label="Net profit"             value={fmt(totals.net)} tone={totals.net < 0 ? "neg" : "pos"} big />
                <Tot label="Net margin"             value={totals.gtv > 0 ? pct(totals.net / totals.gtv) : "—"} tone={totals.net < 0 ? "neg" : "pos"} />
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Hotel History ──────────────────────────────────────────────────── */}
      <section className="history-section">
        <button className="history-toggle" onClick={() => setShowHistory((v) => !v)}>
          <span>{showHistory ? "▾" : "▸"} Hotel history</span>
          <span className="history-count">{history.length} saved</span>
        </button>

        {showHistory && (
          <div className="history-panel">
            <div className="history-search-wrap">
              <input
                className="history-search"
                placeholder="Search hotel name…"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
            </div>
            {filteredHistory.length === 0 ? (
              <p className="history-empty">No hotels saved yet. Add a hotel name + TBO price above and it will appear here.</p>
            ) : (
              <div className="history-table">
                <div className="ht-head">
                  <span>Hotel</span>
                  <span>Check-in</span>
                  <span>TBO/nt</span>
                  <span>Base</span>
                  <span>GST</span>
                  <span>Slab</span>
                  <span>Sell @</span>
                  <span>Net profit</span>
                  <span>Margin</span>
                  <span>Updated</span>
                </div>
                {filteredHistory.map((h) => (
                  <div
                    className="ht-row ht-row-clickable"
                    key={h.id}
                    onClick={() => loadFromHistory(h)}
                    title="Click to load into board"
                  >
                    <span className="ht-name">{h.hotel_name}<em className="ht-load-hint">↑ load</em></span>
                    <span className="ht-date">{h.check_in ? fmtDate(h.check_in) : "—"}</span>
                    <span className="ht-mono">{fmt(h.tbo_gross)}</span>
                    <span className="ht-mono">{fmt(h.tbo_base)}</span>
                    <span className="ht-mono dim">{fmt(h.tbo_gst)}</span>
                    <span className={"ht-slab" + (h.itc_applies ? " itc" : "")}>
                      {h.itc_applies ? "18% ITC" : h.tbo_gross <= 1000 ? "Nil" : "5% no ITC"}
                    </span>
                    <span className="ht-mono">{h.sell_price ? fmt(h.sell_price) : "—"}</span>
                    <span className={"ht-mono " + (h.net_profit != null && h.net_profit < 0 ? "neg" : "pos")}>
                      {h.net_profit != null ? fmt(h.net_profit) : "—"}
                    </span>
                    <span className="ht-mono dim">{h.net_margin_pct != null ? pct(h.net_margin_pct) : "—"}</span>
                    <span className="ht-date">{fmtDate(h.updated_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <footer className="foot">
        <p>Markup is solved so your all-in price exactly matches the cheapest competitor entered. Prices can be entered per-night or for the whole stay; the engine converts everything to per-night, because the GST slab is set by the per-night value of supply, per GST 2.0 effective 22 Sep 2025. You are liable for GST only on the markup you add; TBO&rsquo;s GST is reclaimable as ITC only when the room was bought above &#8377;7,500/night.</p>
      </footer>
      </>)}
    </div>
  );
}

// ── Hotel detail panel ──────────────────────────────────────────────────────
function HotelDetail({ row, res, opexPct, rewardPct }: { row: Row; res: Result; opexPct: number; rewardPct: number }) {
  const hasCost = num(row.tbo) > 0;
  const live = hasCost && res.cheapestCompetitor !== null;
  const loss = live && res.netProfit < 0;
  const n = nightsOf(row);
  const multiNight = n > 1;

  return (
    <div className="hotel-detail">
      <div className="hd-header">
        <span className="hd-name">{row.hotel || <em className="hd-unnamed">Unnamed hotel</em>}</span>
        {row.checkIn && <span className="hd-date-chip">{fmtDate(row.checkIn)} · {n} night{n > 1 ? "s" : ""}</span>}
        {hasCost && (
          <span className="slab-tag" data-itc={res.itcApplies}>
            sell {pct(res.sellSlab.rate)} &middot; {res.itcApplies ? "input ITC ✓" : "5% stuck"}
          </span>
        )}
      </div>

      <div className="hd-grid">
        {/* Cost breakdown */}
        <div className="hd-group">
          <div className="hd-group-label">TBO Cost / night</div>
          <HdCell label="Gross (incl. GST)" value={hasCost ? fmt(toNight(num(row.tbo), row)) : "—"} />
          <HdCell label="Base (net of GST)"  value={hasCost ? fmt(res.tboBase) : "—"} />
          <HdCell
            label={`GST ${pct(res.tboSlab.rate)}`}
            value={hasCost ? fmt(res.tboEmbeddedGst) : "—"}
            sub={hasCost ? (res.itcApplies ? "recoverable via ITC" : res.tboSlab.rate > 0 ? "not recoverable" : "nil slab") : ""}
            subTone={hasCost ? (res.itcApplies ? "pos" : res.tboSlab.rate > 0 ? "neg" : undefined) : undefined}
          />
        </div>

        {/* Pricing */}
        <div className="hd-group">
          <div className="hd-group-label">Pricing / night</div>
          <HdCell label="Sell price"     value={live ? fmt(res.sellingPrice) : "—"} big />
          <HdCell label="Markup"         value={live ? fmt(res.markup) : "—"} sub={live ? pct(res.markupPct) + " on cost" : ""} />
          <HdCell label="GST on markup"  value={live ? fmt(res.gstOnMarkup) : "—"} sub="collected & remitted" />
        </div>

        {/* P&L */}
        <div className="hd-group">
          <div className="hd-group-label">P&amp;L / night</div>
          <HdCell label="Gross profit"  value={live ? fmt(res.grossProfit) : "—"} />
          <HdCell label={`OPEX (${opexPct}%)`} value={live ? "−" + fmt(res.opex) : "—"} />
          <HdCell label={`Reward (${rewardPct}%)`} value={live ? "−" + fmt(res.rewardCost) : "—"} />
          <HdCell label="Net profit"    value={live ? fmt(res.netProfit) : "—"} tone={live ? (loss ? "neg" : "pos") : undefined} big />
          <HdCell label="Net margin"    value={live ? pct(res.netMarginPct) : "—"} tone={live ? (loss ? "neg" : "pos") : undefined} />
        </div>

        {/* Stay total or reward headroom */}
        {multiNight ? (
          <div className="hd-group hd-group-accent">
            <div className="hd-group-label">Whole stay ({n} nights)</div>
            <HdCell label="Sell (all-in)" value={live ? fmt(res.sellingPrice * n) : "—"} big />
            <HdCell label="Net profit"    value={live ? fmt(res.netProfit * n) : "—"} tone={live ? (loss ? "neg" : "pos") : undefined} big />
            <HdCell label="Max reward"    value={live ? pct(res.maxRewardPct) : "—"} />
          </div>
        ) : (
          <div className="hd-group">
            <div className="hd-group-label">Reward headroom</div>
            <HdCell label="Max reward (break-even)" value={live ? pct(res.maxRewardPct) : "—"} big />
            <HdCell label="Current reward"          value={pct(rewardPct / 100)} />
            {live && (
              <HdCell
                label="Headroom left"
                value={res.maxRewardPct - rewardPct / 100 >= 0
                  ? pct(res.maxRewardPct - rewardPct / 100)
                  : "Over break-even"}
                tone={res.maxRewardPct - rewardPct / 100 >= 0 ? "pos" : "neg"}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HdCell({ label, value, sub, subTone, big, tone }: {
  label: string; value: string | React.ReactNode;
  sub?: string; subTone?: "pos" | "neg";
  big?: boolean; tone?: "pos" | "neg";
}) {
  return (
    <div className="hd-cell">
      <span className="hd-cell-label">{label}</span>
      <span className={"hd-cell-value" + (big ? " big" : "") + (tone ? " " + tone : "")}>{value}</span>
      {sub && <span className={"hd-cell-sub" + (subTone ? " " + subTone : "")}>{sub}</span>}
    </div>
  );
}

// ── Shared sub-components ───────────────────────────────────────────────────
function NumCell({ value, onChange, placeholder, muted }: {
  value: string; onChange: (v: string) => void; placeholder?: string; muted?: boolean;
}) {
  return (
    <div className={"numcell" + (muted ? " muted" : "")}>
      <span className="rupee">&#8377;</span>
      <input inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Tot({ label, value, tone, big }: {
  label: string; value: string; tone?: "pos" | "neg"; big?: boolean;
}) {
  return (
    <div className={"tot" + (big ? " big" : "")}>
      <span className="tot-label">{label}</span>
      <span className={"tot-value " + (tone ?? "")}>{value}</span>
    </div>
  );
}
