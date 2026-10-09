# Coverage Ledger Audit — 2026-10-09 (FINAL)

**Repo root:** `/Users/bytedance/openrig`
**Batch dir:** `.codex/translation/review-2026-10-08-batch2/`
**Generated:** 2026-10-09T03:15 (rebuilt after b2-210/b2-211/b2-212 final reruns)
**Method:** read-only recount from full working tree; no tests run, no source modified.
**Final logs incorporated:** b2-205 (daemon-helpers), b2-206 (extras), b2-207 (scripts-comment), b2-208 (refresh-vendored), b2-209 (final4), b2-210 (ui2-retest), b2-211 (final-rebuild), b2-212 (scripts7-rerun).

## 1. Disk denominator (recounted from working tree)

| Workspace | Files |
|---|---:|
| daemon | 734 |
| cli | 195 |
| ui | 199 |
| tui | 86 |
| scripts (`*.test.mjs`, TAP) | 29 |
| **Total** | **1243** |

Matches the historical authoritative denominator of 1243. `results.json`'s recorded `ui=198 / total=1242` undercounted UI by 1; disk confirms 199.

**Basename collisions across workspaces (9):** resolved via the vitest `RUN vX.Y.Z /abs/path` header.

| Basename | Paths |
|---|---|
| attention.test.ts | tui, daemon |
| execution-view.test.ts | tui, daemon |
| index.test.ts | cli, daemon |
| openrig-compat.test.ts | cli, daemon |
| project-navigation.test.ts | tui, daemon |
| reconcile-session.test.ts | cli, daemon |
| startup-proof.test.ts | cli, daemon |
| startup.test.ts | tui, daemon |
| workflow-resume.test.ts | ui, daemon |

## 2. Final bucket counts

| Bucket | Count |
|---|---:|
| latest_pass | 1236 |
| latest_skip | 7 |
| latest_fail | 0 |
| executed_unknown | 0 |
| not_executed | 0 |
| needs_rerun | 0 |
| **Sum** | **1243** |

`sum == disk_total` sanity check passes. All previously-stale files from the interim run have been re-run by the verifier (b2-196 through b2-204) and now show green.

## 3. Legal skip list (7 files, NOT counted as pass)

| Category | File | Reason |
|---|---|---|
| external_paid_blocked | packages/daemon/test/seat-handover-model-fidelity-e2e.test.ts | 依赖真实 Claude/Codex 付费席位，e2e 无法隔离 |
| external_paid_blocked | packages/daemon/test/seat-lifecycle-set-model-resume-e2e.test.ts | 同上 |
| external_paid_blocked | packages/daemon/test/claude-code-adapter-fork-poll.test.ts | 需 `OPENRIG_REAL_CLAUDE_INTEGRATION=1` 真实 Claude |
| blocked_no_real_daemon | packages/cli/test/up.test.ts | 需真实 daemon 启动失败场景，用户禁止启动真 daemon |
| waived_by_alternate_evidence | packages/ui/test/topology-view-mode.test.tsx | 由 topology-view.test.ts + source-assertion 测试替代覆盖 |
| case_skips_in_passing_file | packages/daemon/test/precompact-hook.test.ts | 文件整体通过，2/20 case 被 skip（非 e2e 阻塞） |
| case_skips_in_passing_file | packages/daemon/test/startup-wiring-pins.test.ts | 文件整体通过，5/41 case 被 skip |

Scripts TAP: b2-01 (92 pass) + b2-92 (225 pass, 1 skip, 0 fail) = 317 pass / 1 unattributed skip. TAP output doesn't name the skipped file; recorded as metadata only.

## 4. Latest fail

**None.** All previously known failures were resolved in later batches. No file currently has a FAIL outcome without a later ✓ override.

## 5. Needs-rerun list

**None.** Every disk test file's mtime is older than the last verification log that ran it. The 7 scripts files flagged in the interim (02:54) run were re-run by the verifier in b2-212 (`scripts7-rerun.log`, all 7 pass / 0 fail) and are now green.

## 6. Not executed

**None.** Every disk test file is mentioned in at least one verification log.

## 7. Issues fixed vs prior `rebuild_coverage.py`

1. **Basename folding removed.** Collisions resolved via `RUN` header workspace context.
2. **In-text ordering.** Events walked in text order; later events win (old script ran two passes, FAIL always overwrote ✓).
3. **Singular "test" accepted.** `(1 test)` lines no longer missed.
4. **↓ arrow for fully-skipped files.** Vitest marks fully-skipped files with `↓`.
5. **Staleness / mtime drift.** Each file's mtime compared to last log end-time.
6. **Workspace denominator corrected.** ui=199 (was 198 in results.json).

## 8. Final reconciliation

| Source | pass | skip | fail | not_exec | rerun | total |
|---|---:|---:|---:|---:|---:|---:|
| Verifier final claim | 1236 | 7 | 0 | 0 | 0 | 1243 |
| This rebuild | 1236 | 7 | 0 | 0 | 0 | 1243 |
| **Match** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |

## 9. Outputs

- `rebuild_coverage.py` — corrected read-only script
- `coverage-machine.json` — machine-readable ledger (generated 2026-10-09T02:54:28)
- `COVERAGE-LEDGER-AUDIT-2026-10-09.md` — this report
