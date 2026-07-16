import { getSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

// GET  — load the last saved board state
export async function GET() {
  const supabase = getSupabase();
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
  const supabase = getSupabase();
  const body = await req.json();
  const { rows, opex_pct, reward_pct, benchmark } = body;
  const ts = new Date().toISOString();

  // Try the full save (incl. benchmark). If the benchmark column hasn't been
  // migrated yet, don't let that fail the whole save — retry without it so the
  // rest of the board still persists.
  let { error } = await supabase.from("current_session").upsert(
    { id: "main", rows, opex_pct, reward_pct, benchmark: benchmark ?? [], updated_at: ts },
    { onConflict: "id" }
  );

  if (error && /benchmark/i.test(error.message)) {
    ({ error } = await supabase.from("current_session").upsert(
      { id: "main", rows, opex_pct, reward_pct, updated_at: ts },
      { onConflict: "id" }
    ));
    if (!error) return NextResponse.json({ ok: true, warning: "benchmark column missing — run the ALTER TABLE migration to persist benchmark data" });
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
