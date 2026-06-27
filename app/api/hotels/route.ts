import { supabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

// GET  — fetch hotel history, most recent first
export async function GET() {
  const { data, error } = await supabase
    .from("hotel_history")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST — upsert a single hotel row by name (case-insensitive).
//         Called for every row that has hotel_name + tbo_gross filled in.
export async function POST(req: Request) {
  const body = await req.json();
  const {
    hotel_name,
    tbo_gross,
    tbo_base,
    tbo_gst,
    tbo_slab_label,
    itc_applies,
    mmt,
    goibibo,
    booking,
    sell_price,
    markup,
    net_profit,
    net_margin_pct,
  } = body;

  const name = (hotel_name as string).trim().toLowerCase();
  if (!name || !tbo_gross) return NextResponse.json({ ok: true }); // incomplete row, skip

  // Check if this hotel already exists
  const { data: existing } = await supabase
    .from("hotel_history")
    .select("id")
    .ilike("hotel_name", name)
    .single();

  if (existing) {
    // Update
    await supabase
      .from("hotel_history")
      .update({
        tbo_gross, tbo_base, tbo_gst, tbo_slab_label, itc_applies,
        mmt, goibibo, booking, sell_price, markup, net_profit, net_margin_pct,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    // Insert
    await supabase.from("hotel_history").insert({
      hotel_name: hotel_name.trim(),
      tbo_gross, tbo_base, tbo_gst, tbo_slab_label, itc_applies,
      mmt, goibibo, booking, sell_price, markup, net_profit, net_margin_pct,
    });
  }

  return NextResponse.json({ ok: true });
}
