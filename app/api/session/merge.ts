// Pure, testable core of the save path.
//
// This file exists because every data-loss incident on this project came from
// this logic, not from the database. Keeping it free of Supabase calls means it
// can be unit-tested directly (see merge.test.mjs).

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Prop = any;
export type Board = any;

export const propsOf = (b: Board): Prop[] => (Array.isArray(b?.properties) ? b.properties : []);

/** Total property count across both boards — the number we refuse to let collapse. */
export function countProps(bm: Board): number {
  if (!bm) return 0;
  return propsOf(bm).length + propsOf(bm.roveBoard).length;
}

/**
 * Merge one board (list of properties) instead of replacing it.
 *
 *  - A property the client sends wins for that property (they were editing it).
 *  - A property already in the DB that the client never sent is KEPT — this is
 *    what stops a stale browser tab from deleting someone else's new hotel.
 *  - Deletions must be explicit, via deletedUids.
 */
export function mergeBoard(dbBoard: Board, inBoard: Board, deletedUids: Set<string>): Board {
  if (!inBoard) return dbBoard ?? null;
  if (!dbBoard) {
    return { ...inBoard, properties: propsOf(inBoard).filter((p: Prop) => !deletedUids.has(p.uid)) };
  }

  const byUid = new Map<string, Prop>();
  const legacyKey = (p: Prop) => `legacy:${p?.city ?? ""}|${p?.name ?? ""}`;

  for (const p of propsOf(dbBoard)) if (p && p.uid) byUid.set(p.uid, p);
  // Properties without a uid (legacy rows) are keyed by city+name so they still merge.
  for (const p of propsOf(dbBoard)) if (p && !p.uid) byUid.set(legacyKey(p), p);

  for (const p of propsOf(inBoard)) {
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

/**
 * Would writing `newCount` properties over `dbCount` destroy work?
 * Only the explicitly-requested deletions may reduce the population.
 * Kept separate so it can be asserted directly in tests.
 */
export function wouldDestroy(dbCount: number, newCount: number, deletionCount: number): boolean {
  if (dbCount <= 0) return false;          // nothing stored yet — nothing to lose
  return newCount < dbCount - deletionCount;
}

export type Decision =
  | { ok: true; merged: Board; newCount: number; dbCount: number }
  | { ok: false; status: number; error: string };

/**
 * Decide what to write. This is the whole safety story in one function.
 *
 * @param dbBenchmark  what is currently stored (null if the row does not exist)
 * @param readFailed   true if we could not read the stored state
 * @param incoming     the client's payload (a delta unless writeMode==="full")
 */
export function decideWrite(
  dbBenchmark: Board | null,
  readFailed: boolean,
  incoming: Board,
  deletedUids: Set<string>,
  writeMode: "delta" | "full"
): Decision {
  // 1. A delta is only meaningful relative to a known base. If we cannot read
  //    the base, writing the delta would replace the whole document with the
  //    few properties this tab happened to touch. Refuse instead of guessing.
  //    THIS is the bug that wiped the board on 2026-09-09.
  if (readFailed) {
    return {
      ok: false,
      status: 503,
      error: "Could not read current state; refusing to save so nothing is overwritten.",
    };
  }

  const dbCount = countProps(dbBenchmark);

  let merged = incoming;
  if (incoming && dbBenchmark) {
    merged = mergeBoard(dbBenchmark, incoming, deletedUids);
    merged.roveBoard = mergeBoard(dbBenchmark.roveBoard, incoming.roveBoard, deletedUids);
  }

  // 2. After merging, the result may only shrink by the number of properties
  //    explicitly deleted. Any other shrink means something upstream went
  //    wrong, and we would rather fail a save than destroy work.
  const newCount = countProps(merged);
  if (writeMode !== "full" && wouldDestroy(dbCount, newCount, deletedUids.size)) {
    return {
      ok: false,
      status: 409,
      error:
        `Refusing to save: this would drop ${dbCount - newCount} of ${dbCount} properties ` +
        `(only ${deletedUids.size} deletion(s) were requested). Nothing was changed.`,
    };
  }

  return { ok: true, merged, newCount, dbCount };
}
