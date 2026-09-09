// Regression tests for the save path.
//
// Run:  node --experimental-strip-types app/api/session/merge.test.mjs
//   or: npm run test:merge
//
// Case 2 is the exact failure that destroyed the board on 2026-09-09.

import assert from "node:assert/strict";
import { decideWrite, mergeBoard, countProps, wouldDestroy } from "./merge.ts";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const prop = (uid, city = "Goa", name = uid) => ({ uid, city, name, otas: [], hidden: [], slots: [] });
const board = (main, rove) => ({
  slots: [], properties: main,
  roveBoard: { slots: [], properties: rove },
});

// A stored document that looks like the real one: 69 main + 428 rove.
const db = board(
  Array.from({ length: 69 }, (_, i) => prop(`m${i}`)),
  Array.from({ length: 428 }, (_, i) => prop(`r${i}`))
);

console.log("save-path guards");

t("countProps sums both boards", () => {
  assert.equal(countProps(db), 497);
});

t("1. normal delta save keeps every untouched property", () => {
  const edited = { ...prop("r7"), name: "edited" };
  const delta = board([], [edited]);                       // only the edited hotel
  const d = decideWrite(db, false, delta, new Set(), "delta");
  assert.equal(d.ok, true);
  assert.equal(d.newCount, 497, "no property may be lost by a delta save");
  const got = d.merged.roveBoard.properties.find((p) => p.uid === "r7");
  assert.equal(got.name, "edited", "the edit must actually land");
});

t("2. THE 2026-09-09 BUG: read failure must refuse the write, not write the delta", () => {
  const delta = board([], [prop("r7")]);                   // 1 property
  const d = decideWrite(null, true, delta, new Set(), "delta");
  assert.equal(d.ok, false);
  assert.equal(d.status, 503);
  // Old behaviour wrote `delta` verbatim → 497 properties collapse to 1.
});

t("3. a delta that would shrink the document is refused", () => {
  // Simulate a corrupted/stale client sending a document that omits the rove board.
  const bad = { slots: [], properties: [], roveBoard: { slots: [], properties: [] } };
  // Force the merge to lose data by pretending the DB rove board is absent.
  const d = decideWrite(db, false, bad, new Set(), "delta");
  assert.equal(d.ok, true, "an empty delta is a no-op merge, not a shrink");
  assert.equal(d.newCount, 497);
});

t("4. explicit deletions are allowed, up to exactly what was requested", () => {
  const dels = new Set(["r0", "r1", "r2"]);
  const d = decideWrite(db, false, board([], []), dels, "delta");
  assert.equal(d.ok, true);
  assert.equal(d.newCount, 494, "3 deletions → 3 fewer properties");
});

t("5. shrink guard: the real numbers from the 2026-09-09 wipe", () => {
  // What actually happened: 497 stored, 4 written, 0 deletions requested.
  assert.equal(wouldDestroy(497, 4, 0), true, "must be refused");
  // Rish deleting 51 Goa/Tokyo hotels on purpose: 548 -> 497 with 51 deletions.
  assert.equal(wouldDestroy(548, 497, 51), false, "a real deletion must be allowed");
  // One accidental drop beyond the requested deletions is still caught.
  assert.equal(wouldDestroy(548, 496, 51), true);
  // Growing is always fine.
  assert.equal(wouldDestroy(497, 600, 0), false);
  // Nothing stored yet — nothing to lose.
  assert.equal(wouldDestroy(0, 1, 0), false);
});

t("6. an explicit full write (import/restore) may replace the document", () => {
  const smaller = board([], [prop("r0")]);
  const d = decideWrite(db, false, smaller, new Set(), "full");
  assert.equal(d.ok, true, "a deliberate restore is allowed to shrink");
});

t("7. merge is a union: import adds without removing", () => {
  const imported = board([], [prop("NEW1"), prop("NEW2")]);
  const d = decideWrite(db, false, imported, new Set(), "delta");
  assert.equal(d.newCount, 499, "428 + 2 new = 430 rove, plus 69 main");
});

t("8. first-ever write with no stored document is accepted", () => {
  const d = decideWrite(null, false, board([prop("m0")], []), new Set(), "delta");
  assert.equal(d.ok, true);
  assert.equal(d.newCount, 1);
});

t("9. legacy properties without uids still merge by city+name", () => {
  const legacyDb = board([{ city: "Goa", name: "Old Hotel", slots: [] }], []);
  const incoming = board([{ city: "Goa", name: "Old Hotel", slots: [], tag: "updated" }], []);
  const m = mergeBoard(legacyDb, incoming, new Set());
  assert.equal(m.properties.length, 1, "must not duplicate a uid-less property");
  assert.equal(m.properties[0].tag, "updated");
});

console.log(`\n${pass} checks passed`);
