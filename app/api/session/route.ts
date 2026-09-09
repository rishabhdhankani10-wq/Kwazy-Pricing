import { getSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { countProps, decideWrite, type Board } from "./merge";

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

/**
 * Keep a copy of the document BEFORE we overwrite it.
 * Best-effort: if the table does not exist the save still proceeds, because the
 * refuse-on-shrink guard in decideWrite() is the primary protection — snapshots
 * are the second layer, not the only one.
 */
async function snapshot(
  supabase: ReturnType<typeof getSupabase>,
  benchmark: Board,
  reason: string
): Promise<void> {
  try {
    await supabase.from("session_backups").insert({
      session_id: "main",
      reason,
      prop_count: countProps(benchmark),
      benchmark,
    });
  } catch {
    /* best effort */
  }
}

/** True when the newest snapshot is older than `minutes` (or there is none). */
async function snapshotIsStale(
  supabase: ReturnType<typeof getSupabase>,
  minutes: number
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("session_backups")
      .select("saved_at")
      .eq("session_id", "main")
      .order("saved_at", { ascending: false })
      .limit(1);
    if (error) return false;            // table missing — don't block the save
    if (!data || !data.length) return true;
    const last = new Date(data[0].saved_at as string).getTime();
    return Date.now() - last > minutes * 60_000;
  } catch {
    return false;
  }
}

// PUT  — merge the incoming board state into what's stored
export async function PUT(req: Request) {
  const supabase = getSupabase();
  const body = await req.json();
  const { rows, opex_pct, reward_pct, benchmark, deletedUids } = body;
  // "delta" = client sent only the properties it edited (the normal autosave).
  // "full"  = client is deliberately replacing the document (import / restore).
  const writeMode: "delta" | "full" = body.writeMode === "full" ? "full" : "delta";
  const ts = new Date().toISOString();
  const dels: Set<string> = new Set(Array.isArray(deletedUids) ? deletedUids : []);

  // The read is not optional — see decideWrite() for why.
  const { data: existing, error: readErr } = await supabase
    .from("current_session")
    .select("benchmark")
    .eq("id", "main")
    .maybeSingle();

  const decision = decideWrite(
    existing?.benchmark ?? null,
    Boolean(readErr),
    benchmark,
    dels,
    writeMode
  );

  if (!decision.ok) {
    return NextResponse.json(
      { error: decision.error, detail: readErr?.message },
      { status: decision.status }
    );
  }

  const { merged, newCount, dbCount } = decision;
  const dbBenchmark = existing?.benchmark ?? null;

  // Snapshot the outgoing document before any write that changes the population,
  // on explicit full/restore writes, and otherwise at most once every 30 minutes
  // so edits to existing hotels (which never change the count) are covered too.
  if (dbBenchmark && dbCount > 0) {
    if (writeMode === "full") {
      await snapshot(supabase, dbBenchmark, "before-full-write");
    } else if (newCount !== dbCount) {
      await snapshot(supabase, dbBenchmark, "count-change");
    } else if (await snapshotIsStale(supabase, 30)) {
      await snapshot(supabase, dbBenchmark, "periodic");
    }
  }

  let { error } = await supabase.from("current_session").upsert(
    { id: "main", rows, opex_pct, reward_pct, benchmark: merged ?? [], updated_at: ts },
    { onConflict: "id" }
  );

  if (error && /benchmark/i.test(error.message)) {
    ({ error } = await supabase.from("current_session").upsert(
      { id: "main", rows, opex_pct, reward_pct, updated_at: ts },
      { onConflict: "id" }
    ));
    if (!error) {
      return NextResponse.json({
        ok: true,
        warning: "benchmark column missing — run the ALTER TABLE migration to persist benchmark data",
      });
    }
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, propCount: newCount });
}
