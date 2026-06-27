import { supabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

// GET  — load the last saved board state
export async function GET() {
  const { data, error } = await supabase
    .from("current_session")
    .select("*")
    .eq("id", "main")
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine on first load
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? null);
}

// PUT  — upsert the full board state
export async function PUT(req: Request) {
  const body = await req.json();
  const { rows, opex_pct, reward_pct } = body;

  const { error } = await supabase.from("current_session").upsert(
    { id: "main", rows, opex_pct, reward_pct, updated_at: new Date().toISOString() },
    { onConflict: "id" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
