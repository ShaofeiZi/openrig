# 台账纠错审计记录 — 2026-10-08 batch2

本记录为独立、可引用的台账审计条目，显式记录一次定位错误及其纠正（不依赖单条 note）。

## 错误
- 动作：将 `packages/ui/test/scope-pages-story-summary.test.ts`（owner ui-a）validation_state 由 validated 转为 passed。
- 根因：验证日志 b2-39 实际冻结的第二个文件是 `packages/ui/test/scopepages-progress-remote-gate.test.tsx`（owner ui-c）；我按近似文件名（"scope pages"）定位，误选了同目录另一文件。
- 依据日志：`verification-logs/b2-39-ui-2frozen.log` 明确列出：
  - `test/attention-feed.test.ts`（17 tests）
  - `test/scopepages-progress-remote-gate.test.tsx`（3 tests）
  - 合计 20 passed (2) files。

## 纠正（经 state.py 锁，before 快照存 before-ui-attention-scoped-pages-2026-10-08.json）
1. scope-pages-story-summary.test.ts：passed → 恢复 validated（非 b2-39 对象）。
2. scopepages-progress-remote-gate.test.tsx：validated → passed（b2-39 正确对象，3 tests）。
3. attention-feed.test.ts：passed（正确，未动）。

## 净效与自洽
- 一错一正互换，done 内交叉净变零：self_reported1961 / validated852 / passed105 / needs_review2 = 2920。
- 纠正后逐条核验：attention=passed、scope-pages-story-summary=validated、scopepages-progress-remote-gate=passed。

## 流程教训（永久约束）
- 凡按测试/验证证据更新台账，必须以准确 `source_path` 字符串精确匹配验证日志文件列表，禁止按近似/同名模式猜测。
- 写入前先定位真实记录（跨全部 owner manifest 精确匹配），不存在则补登记，不用近似路径替代。

## 2026-10-08 batch2 追加：CLI 作者撤回 big4 全文完成
- 触发：作者诚实撤回，严格重扫仍有自然语言注释；测试通过仅行为验证，不冒全文翻译。
- 锁内变更（fcntl per-owner + rebuild）：
  - cli-b packages/cli/test/queue.test.ts: validation passed -> needs_review（note: 测试100过仅行为验证；注释补译in_progress）
  - daemon-core-h packages/daemon/test/bundle-routes.test.ts: self_reported -> needs_review（约98处自然语言注释in_progress）
  - daemon-core-g packages/daemon/src/domain/restore-check-service.ts: self_reported -> needs_review
  - daemon-core-i packages/daemon/test/restore-check-service.test.ts: self_reported -> needs_review
- status 保持 done（记录存在），validation_state 降为 needs_review；不以测试过冒充全文中文化。
- 作者新20个 in-progress 文件已送验证者避让；restore schema 机器 canonical drift fail 作者修中。

## 纠错（近似路径误改）：big4 正确集合
- 上一条误把 restore-check-service src+test 当回退对象。经精确 source_path 复核，CLI 作者撤回的是 restore-packet 系，不是 restore-check-service。
- 已回退：daemon-core-g restore-check-service.ts、daemon-core-i restore-check-service.test.ts 恢复 self_reported，并清掉误加 note。
- 正确 needs_review 四条（status 仍 done）：
  - cli-b packages/cli/test/queue.test.ts（passed->needs_review）
  - daemon-core-h packages/daemon/test/bundle-routes.test.ts
  - cli-a packages/cli/test/restore-packet.test.ts
  - cli-core-a packages/cli/test/daemon-lifecycle.test.ts
- 规则重申：一律按精确 source_path 匹配，禁止近似名。

## 2026-10-08 终：343 doc 一致性自检 + 台账批转 passed
- 一致性自检：权威 343 每 path 恰一合格证据（归一化 doc343-qualified-evidence-index.txt）。evidence_type（修正后，verifier must-contain matched 2/2）：full_read 298 + vendored_SAME 45 = 343；unique paths 343 / dup 0。
- 修正记录：原索引误把 docker/testbed/runbooks/L3-daemon-in-container.md（log #160 read 1..146 实为全文读）标为 vendored_SAME；已改 full_read。vendored_SAME 真实=45（与 VENDORED-EQUIVALENCE-EVIDENCE-2026-10-08.txt 的 45 条 SAME 一致；45 条 canonical path 均真实存在且自身在 full_read 集合）。duplicates/missing/extra=0（54 历史重复行按"最佳/最新合格行胜"归一，占位聚合行 docs/releases/(其余31篇changelog) 排除；docs/openrig-zrig-handoff 为范围外旁注不入权威）。
- EN before/after：docs-en-before-snapshot.json 343 源，转后 hash 0 变更；target 全存在。
- 台账批转（按 owner fcntl 锁，精确 source_path）：343 全部 status=done/category=doc，validation_state 由 self_reported 307+validated 36 → passed 343；附 note 本批证据。skipped/pending/in_progress among 343 = 0，无需单列。rebuild 后交叉自洽。
- 范围：仅 root/docs 中文译本权限内；packages 只读 0 缺口；未改原英文 MD。

## 2026-10-08：doc 证据计数修正 + big4 转 passed
- doc 证据修正：index 原 vendored_SAME 46 为误标（docker/testbed/runbooks/L3-daemon-in-container.md #160 实为 read 1..146 全文读）。修正后 full_read 298 + vendored_SAME 45 = 343，unique 343/dup 0；verifier must-contain matched 2/2（full_read 298、vendored_SAME 45）。不影响 343 已 passed。
- big4 转 passed（before 快照 big4-before-snapshot.json；按 owner fcntl 锁；note b2-97+batch2 big4 report；机器 fixture/JSON 保留）：cli-b queue.test.ts、cli-core-a daemon-lifecycle.test.ts、cli-a restore-packet.test.ts、daemon-core-h bundle-routes.test.ts，均 needs_review→passed。
- 保留 needs_review（桌面视觉阻塞）：tui hydrate.ts、tui text-width.ts。剩余 needs_review 全局=2。
- UI pending 3（build-setup-prompt/bundle-inspector/package-list）保留：新增精准断言但注释全译未审。

## 2026-10-08：UI pending3 只读审计 + build-setup 转 passed
- build-setup-prompt.test.ts（ui-a）：pending→done+passed。只读审计：describe/it 标题全中文、无英文注释、机器串保留；作者全文审读全中文；相关测试通过。未改文件。
- bundle-inspector.test.tsx / package-list.test.tsx（ui-b，已 done+validated）：逐行审计发现英文注释与英文 it() 标题残留（如 "shows manifest name..."/"renders package cards..."/Test 1/2/4/5/8 注释）。保持 validated，不升 passed（注释未全译）。
- TUI 标题批：当前 tui done+passed=96、validated=1、self_reported=55、needs_review=2。为避免近似路径误改（参照 scopepages 教训），标题批需作者提供精确文件清单后再 demote 为 validated+note，不凭猜测批量回退。
