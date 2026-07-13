"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { DayPicker, type DateRange as RDPRange } from "react-day-picker";
import "react-day-picker/style.css";

const toDate = (s: string) => (s ? new Date(s + "T00:00:00") : undefined);
const toISO = (d?: Date) => (d ? d.toISOString().slice(0, 10) : "");
const short = (s: string) =>
  s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";

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
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Position the portal popover under the button.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 300); // keep on screen
    setPos({ top: r.bottom + 4, left: Math.max(8, left) });
  }, [open]);

  // Close on outside click, scroll, or Escape.
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

  const range: RDPRange | undefined = checkIn
    ? { from: toDate(checkIn), to: toDate(checkOut) }
    : undefined;

  const nights =
    checkIn && checkOut
      ? Math.max(0, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000))
      : 0;

  const label = checkIn
    ? checkOut
      ? `${short(checkIn)} → ${short(checkOut)} · ${nights}n`
      : `${short(checkIn)} → …`
    : "Select dates";

  return (
    <div className="drange" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={"drange-btn" + (compact ? " compact" : "") + (checkIn ? "" : " empty")}
        onClick={() => setOpen((o) => !o)}
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
            <DayPicker
              mode="range"
              numberOfMonths={1}
              defaultMonth={toDate(checkIn)}
              selected={range}
              onSelect={(r?: RDPRange) => {
                onChange(toISO(r?.from), toISO(r?.to));
                if (r?.from && r?.to) setOpen(false);
              }}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
