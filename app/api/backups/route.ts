import { getSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

// GET /api/backups            → list the stored snapshots (metadata only)
// GET /api/backups?id=123     → fetch one snapshot's full benchmark document
export async function GET(req: Request) {
  const supabase = getSupabase();
  const id = new URL(req.url).searchParams.get("id");

  if (id) {
    const { data, error } = await supabase
      .from("session_backups")
      .select("id, saved_at, reason, prop_count, benchmark")
      .eq("id", Number(id))
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  const { data, error } = await supabase
    .from("session_backups")
    .select("id, saved_at, reason, prop_count")
    .eq("session_id", "main")
    .order("saved_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json(
      { error: error.message, hint: "Run supabase/session_backups.sql once in the Supabase SQL editor." },
      { status: 500 }
    );
  }
  return NextResponse.json(data ?? []);
}

// POST /api/backups  { id }   → restore that snapshot into current_session.
// The document being replaced is itself snapshotted first, so a restore is
// always reversible.
export async function POST(req: Request) {
  const supabase = getSupabase();
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: snap, error: snapErr } = await supabase
    .from("session_backups")
    .select("benchmark, prop_count")
    .eq("id", Number(id))
    .single();
  if (snapErr || !snap) {
    return NextResponse.json({ error: snapErr?.message ?? "snapshot not found" }, { status: 404 });
  }

  const { data: cur, error: curErr } = await supabase
    .from("current_session")
    .select("benchmark")
    .eq("id", "main")
    .maybeSingle();
  if (curErr) {
    return NextResponse.json(
      { error: "Could not read current state; refusing to restore.", detail: curErr.message },
      { status: 503 }
    );
  }

  if (cur?.benchmark) {
    const b = cur.benchmark;
    const count =
      (Array.isArray(b?.properties) ? b.properties.length : 0) +
      (Array.isArray(b?.roveBoard?.properties) ? b.roveBoard.properties.length : 0);
    await supabase.from("session_backups").insert({
      session_id: "main",
      reason: "before-restore",
      prop_count: count,
      benchmark: b,
    });
  }

  const { error } = await supabase
    .from("current_session")
    .update({ benchmark: snap.benchmark, updated_at: new Date().toISOString() })
    .eq("id", "main");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, restored: snap.prop_count });
}
