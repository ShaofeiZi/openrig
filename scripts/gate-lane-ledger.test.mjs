import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLedger,
  resolveGateWithLedger,
  renderLedgerState,
  CUT_CEILING_ISO,
  LEDGER_ENTRY_FIELDS,
} from "./gate-lane-ledger.mjs";

// F1 排除台账——四条轨道的机制（PM 裁决，“带牙齿”）。空种子：named-6 是被“杀掉”而非“排除”，
// 所以 main 是真绿的，台账里没有常驻者。这些测试在夹具台账上证明各轨道（确定性地注入 `now` + `cutCeiling`），
// 使这套机制成为未来某次裁剪里“修不好的基础健康套件”的持久安全带。
//
//   轨道 1  带排除仍为绿——失败被生效常驻者覆盖 → 闸门 PASS，带内点名
//   轨道 2  机制化到期——常驻者过期 → 闸门 FAIL（迫使其移除；自我消亡）
//   轨道 3  收据+归属+到期——每个常驻者带 A/B 收据、一个 owner、一个到期日
//   轨道 4  裁剪上限——任何常驻者到期日不得晚于 0.5.2 裁剪

const CEIL = "2025-09-01"; // an explicit test ceiling (the real one is CUT_CEILING_ISO)
const ok = (over = {}) => ({ suite: "flaky-suite", reason: "contention flake", receipt: "A/B sha abc", owner: "dev-driver", expiry: "2025-08-20", ...over });

// ---- 轨道 3：schema ----------------------------------------------------------------------------
test("rail 3 — a resident missing receipt/owner/expiry is REJECTED (each named)", () => {
  const r = validateLedger([{ suite: "x", reason: "r" }], { cutCeiling: CEIL });
  assert.equal(r.valid, false);
  for (const field of ["receipt", "owner", "expiry"]) {
    assert.ok(r.errors.some((e) => e.includes(field)), `missing ${field} must be reported`);
  }
});

test("rail 3 — LEDGER_ENTRY_FIELDS names the required schema (receipt+owner+expiry+suite+reason)", () => {
  for (const f of ["suite", "reason", "receipt", "owner", "expiry"]) {
    assert.ok(LEDGER_ENTRY_FIELDS.includes(f), `${f} is a required ledger field`);
  }
});

// ---- 轨道 4：裁剪上限 ---------------------------------------------------------------------------
test("rail 4 — a resident whose expiry EXCEEDS the cut ceiling is REJECTED", () => {
  const r = validateLedger([ok({ expiry: "2099-12-31" })], { cutCeiling: CEIL });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /裁剪上限/.test(e)), "ceiling violation must be reported");
});

test("rail 4 — a well-formed resident within the ceiling VALIDATES clean", () => {
  const r = validateLedger([ok()], { cutCeiling: CEIL });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("rail 4 — CUT_CEILING_ISO is a real ISO date (the mechanism has a concrete ceiling)", () => {
  assert.match(CUT_CEILING_ISO, /^\d{4}-\d\d-\d\d/);
  assert.equal(Number.isNaN(Date.parse(CUT_CEILING_ISO)), false);
});

// ---- 轨道 1：带排除仍为绿 -----------------------------------------------------------------------
test("rail 1 — a failure COVERED by an active resident → gate PASS, the exclusion is NAMED", () => {
  const r = resolveGateWithLedger({ failures: ["flaky-suite"], ledger: [ok()], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "pass");
  assert.deepEqual(r.covered, ["flaky-suite"]);
  assert.deepEqual(r.uncovered, []);
  assert.equal(r.activeExclusions.length, 1);
  assert.match(renderLedgerState(r), /flaky-suite/); // loud, in-band
});

test("rail 1 — an UNCOVERED failure → gate FAIL (no resident to hide behind)", () => {
  const r = resolveGateWithLedger({ failures: ["surprise-suite"], ledger: [ok()], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.deepEqual(r.uncovered, ["surprise-suite"]);
});

// ---- 轨道 2：机制化到期 -------------------------------------------------------------------------
test("rail 2 — an EXPIRED resident no longer covers its failure → gate FAIL", () => {
  const r = resolveGateWithLedger({ failures: ["flaky-suite"], ledger: [ok({ expiry: "2025-08-01" })], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.ok(r.expired.includes("flaky-suite"));
  assert.deepEqual(r.covered, []);
});

test("rail 2 — an expired resident forces RED even when its suite PASSES now (stale exclusion must be removed)", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [ok({ suite: "old-suite", expiry: "2025-08-01" })], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.ok(r.expired.includes("old-suite"));
});

// ---- 空种子（发货的真实情况）-------------------------------------------------------------------
test("EMPTY SEED — zero residents + zero failures → clean PASS, no exclusions named", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "pass");
  assert.deepEqual(r.activeExclusions, []);
  assert.match(renderLedgerState(r), /0 项排除/);
});

test("EMPTY SEED — zero residents + any failure → FAIL (the gate is strict by default)", () => {
  const r = resolveGateWithLedger({ failures: ["anything"], ledger: [], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
});
