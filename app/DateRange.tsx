"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

const pad = (n: number) => String(n).padStart(2, "0");
// Local-date formatting (NOT toISOString, which shifts the day in +5:30).
const fmtISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s: string | undefined | null): Date | null => {
  if (!s || typeof s !== "string") return null;
  const parts = s.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
};
const short = (s: string) => {
  const d = parseISO(s);
  return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";
};

const WEEK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function DateRange({
  checkIn,
  checkOut,
  onChange,
  compact,
}: {
  checkIn: string;
  checkOut: string;
  onChange: (from: string, to: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [view, setView] = useState<Date>(() => parseISO(checkIn) ?? new Date());
  // In-progress selection, held internally so the two-click flow never depends
  // on the parent re-rendering between clicks.
  const [draft, setDraft] = useState<{ from: Date | null; to: Date | null }>({ from: null, to: null });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 280);
    setPos({ top: r.bottom + 4, left: Math.max(8, left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const openCal = () => {
    setDraft({ from: parseISO(checkIn), to: parseISO(checkOut) });
    setView(parseISO(checkIn) ?? new Date());
    setOpen(true);
  };

  const pick = (day: Date) => {
    if (!draft.from || draft.to) {
      // no start yet, or a full range already exists -> begin a new range
      setDraft({ from: day, to: null });
      onChange(fmtISO(day), "");
    } else if (day.getTime() < draft.from.getTime()) {
      // clicked before the start -> restart from here
      setDraft({ from: day, to: null });
      onChange(fmtISO(day), "");
    } else {
      // complete the range
      setDraft({ from: draft.from, to: day });
      onChange(fmtISO(draft.from), fmtISO(day));
      setOpen(false);
    }
  };

  const ci = parseISO(checkIn);
  const co = parseISO(checkOut);
  const nights = ci && co ? Math.max(0, Math.round((co.getTime() - ci.getTime()) / 86_400_000)) : 0;
  const label = ci
    ? co
      ? `${short(checkIn)} → ${short(checkOut)} · ${nights}n`
      : `${short(checkIn)} → …`
    : "Select dates";

  // Month grid.
  const y = view.getFullYear();
  const m = view.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));

  const todayT = (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(); })();
  const cellClass = (d: Date) => {
    const t = d.getTime();
    let c = "drange-day";
    if (draft.from && t === draft.from.getTime()) c += " sel start";
    if (draft.to && t === draft.to.getTime()) c += " sel end";
    if (draft.from && draft.to && t > draft.from.getTime() && t < draft.to.getTime()) c += " between";
    if (t === todayT) c += " today";
    return c;
  };

  return (
    <div className="drange" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={"drange-btn" + (compact ? " compact" : "") + (checkIn ? "" : " empty")}
        onClick={() => (open ? setOpen(false) : openCal())}
      >
        {label}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className="drange-pop"
            style={{ top: pos.top, left: pos.left }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drange-cal-head">
              <button type="button" className="drange-nav" onClick={() => setView(new Date(y, m - 1, 1))}>‹</button>
              <span className="drange-title">{MONTHS[m]} {y}</span>
              <button type="button" className="drange-nav" onClick={() => setView(new Date(y, m + 1, 1))}>›</button>
            </div>
            <div className="drange-grid">
              {WEEK.map((w) => (
                <span className="drange-wd" key={w}>{w}</span>
              ))}
              {cells.map((d, i) =>
                d ? (
                  <button type="button" key={i} className={cellClass(d)} onClick={() => pick(d)}>
                    {d.getDate()}
                  </button>
                ) : (
                  <span key={i} />
                )
              )}
            </div>
            <div className="drange-foot">
              <span>{draft.from && !draft.to ? "Now pick check-out" : "Pick check-in, then check-out"}</span>
              {(checkIn || draft.from) && (
                <button type="button" className="drange-clear" onClick={() => { setDraft({ from: null, to: null }); onChange("", ""); setOpen(false); }}>
                  Clear
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
