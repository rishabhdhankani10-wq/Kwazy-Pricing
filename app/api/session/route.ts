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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prop = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Board = any;

/**
 * Merge one board (list of properties) instead of replacing it.
 *
 * Rules:
 *  - A property the client sends wins for that property (they were editing it).
 *  - A property already in the DB that the client never sent is KEPT — this is
 *    what stops a stale browser tab from deleting someone else's new hotel.
 *  - Deletions must be explicit, via deletedUids.
 */
function mergeBoard(dbBoard: Board, inBoard: Board, deletedUids: Set<string>): Board {
  if (!inBoard) return dbBoard ?? null;
  if (!dbBoard) {
    return { ...inBoard, properties: (inBoard.properties ?? []).filter((p: Prop) => !deletedUids.has(p.uid)) };
  }

  const dbProps: Prop[] = Array.isArray(dbBoard.properties) ? dbBoard.properties : [];
  const inProps: Prop[] = Array.isArray(inBoard.properties) ? inBoard.properties : [];

  const byUid = new Map<string, Prop>();
  for (const p of dbProps) if (p && p.uid) byUid.set(p.uid, p);
  // Properties without a uid (legacy rows) are keyed by city+name so they still merge.
  const legacyKey = (p: Prop) => `legacy:${p?.city ?? ""}|${p?.name ?? ""}`;
  for (const p of dbProps) if (p && !p.uid) byUid.set(legacyKey(p), p);

  for (const p of inProps) {
    if (!p) continue;
    byUid.set(p.uid ?? legacyKey(p), p); // client's version wins for this property
  }

  for (const uid of deletedUids) byUid.delete(uid);

  return {
    ...dbBoard,
    ...inBoard,                       // slots / usdRate come from the client
    properties: [...byUid.values()],
  };
}

// PUT  — merge the incoming board state into what's stored
export async function PUT(req: Request) {
  const supabase = getSupabase();
  const body = await req.json();
  const { rows, opex_pct, reward_pct, benchmark, deletedUids } = body;
  const ts = new Date().toISOString();
  const dels: Set<string> = new Set(Array.isArray(deletedUids) ? deletedUids : []);

  // Read current state so we can merge rather than clobber.
  const { data: existing } = await supabase
    .from("current_session")
    .select("benchmark")
    .eq("id", "main")
    .single();

  let merged = benchmark;
  if (benchmark && existing?.benchmark) {
    const db = existing.benchmark;
    merged = mergeBoard(db, benchmark, dels);
    merged.roveBoard = mergeBoard(db.roveBoard, benchmark.roveBoard, dels);
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
  return NextResponse.json({ ok: true });
}
