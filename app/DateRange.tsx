"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

const pad = (n: number) => String(n).padStart(2, "0");
// Local-date formatting (NOT toISOString, which shifts the day in +5:30).
const fmtISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s: string): Date | null => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
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
    const scroll = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const from = parseISO(checkIn);
  const to = parseISO(checkOut);

  const openCal = () => {
    setView(parseISO(checkIn) ?? new Date());
    setOpen(true);
  };

  const pick = (day: Date) => {
    if (!from || (from && to)) {
      onChange(fmtISO(day), ""); // start a fresh range
    } else if (day.getTime() < from.getTime()) {
      onChange(fmtISO(day), ""); // clicked earlier than start -> restart
    } else {
      onChange(fmtISO(from), fmtISO(day)); // complete the range
      setOpen(false);
    }
  };

  const nights = from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000)) : 0;
  const label = checkIn
    ? checkOut
      ? `${short(checkIn)} → ${short(checkOut)} · ${nights}n`
      : `${short(checkIn)} → …`
    : "Select dates";

  // Build the month grid.
  const y = view.getFullYear();
  const m = view.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));

  const today = new Date();
  const cellClass = (d: Date) => {
    let c = "drange-day";
    if (from && d.getTime() === from.getTime()) c += " sel start";
    if (to && d.getTime() === to.getTime()) c += " sel end";
    if (from && to && d.getTime() > from.getTime() && d.getTime() < to.getTime()) c += " between";
    if (d.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) c += " today";
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
              {from && !to ? "Pick the check-out date" : "Pick check-in, then check-out"}
              {checkIn && (
                <button type="button" className="drange-clear" onClick={() => { onChange("", ""); setOpen(false); }}>
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
