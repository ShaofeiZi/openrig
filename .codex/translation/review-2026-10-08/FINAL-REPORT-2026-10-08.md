# 中文化台账只读核查报告 — 2026-10-08

核查人：统一台账写者（唯一写者）。范围：全量中文化台账 vs 源码实际覆盖，只读核查 + 台账维护。未改任何产品源码/原英文文档；未跑构建/typecheck/测试（验证由独立执行者完成）。

## 0. 分母定义
- 真源 = `.codex/translation/manifests/<owner>.json` 分片（owner 互斥）；`_records.json`/`plan.md` 由 `state.py rebuild` 从分片重建。
- **零点（核查起点）= 3062 行**。核查中补登 2 条 tracked 漏登后 → **现 3064 行**（分母已变更，分列如下）。
- 剔除项（不计目标，按 .gitignore/构建规则）：`packages/cli/daemon/`（build-package.sh 组装的 vendored 副本，gitignore）、`packages/daemon/context-packs/`（包时派生生成，gitignore）、`dist/`、`node_modules/`、`.claude/`、`.agents/`、`.openrig`、`.worktrees/`、`demo/proof/`、`docs/*`（仅 as-built/reference/releases 为发布文档）、`*.zh-CN.md`（中文伴随版产出本身）、`*.generated.*`。

## 1. 按状态精确计数（重建后，重算）
| status | 零点3062 | 现3064 |
| --- | ---: | ---: |
| done | 2917 | 2917 |
| skipped | 145 | 145 |
| pending | 0 | **2** |
| in_progress | 0 | 0 |
| failed | 0 | 0 |

分类：code-comment 2532、doc 343、config-template 115、meta 45、manifest 29。

## 2. 自报 done vs 历史验证标记（重要校正）
done=2917 的 `validation_state`（within-done，自洽）：
- self_reported（自报、无验收）= 1965
- validated = 846；passed = 101 → **历史验证标记合计 947**
（全表 self_reported=1968 = done 内 1965 + skipped 内 3，不同分母分列。）

**校正**：validated 846 + passed 101 = 947 **只能称"带历史验证标记"，不是"本次实际已验收"**。
证据抽查（sample 20 条 validated/passed）：
- 记录本身无时间戳、无内容 hash、无证据路径；notes 仅为翻译叙述。
- 20 条中 17 条无任何提及，3 条仅见于 9/29–9/30 报告级旧日志。
- **不能据此推断 947 总体的"无证据"比例**；仅能说抽样多数无逐文件可追溯证据，旧日志早于当前工作树。需对照现版本重验方可计入本轮验收。

## 3. 一致性核查
- 源路径磁盘不存在 = 0；跨 owner 重复 = 0；分片内重复 = 0；records 内重复 = 0；records↔manifests 漂移 = 0。
- doc 类 done 的中文伴随版缺失 = 0（target 文件均在盘）。

## 4. 真实漏登文件（剔除生成目录后）
| 文件 | 盘状态 | 分区 | 处置 |
| --- | --- | --- | --- |
| packages/tui/src/text-width.ts | tracked | TUI | 已补登，status=pending（CJK 显示宽度/截断，style-spec 重点） |
| scripts/zrig-entry.test.mjs | tracked | CLI/daemon root(entry) | 已补登，status=pending |
| docs/openrig-zrig-handoff.md | 未跟踪/忽略(docs/* gitignore) | docs | 不计零点新增 |
| packages/ui/test/build-setup-prompt.test.ts | 未跟踪 | Web UI(test) | 由 UI 者先读确认；若纳入，零点之外单列 |

其余 ~500 个"磁盘有、台账无"文件全部落在 gitignore 的 `packages/cli/daemon/` vendored 副本，按规则排除。

## 5. 分区高价值缺口（已路由给对应修改者）
- **CLI/daemon**（owner: entry/cli-a/cli-b/cli-core-*/daemon-api/daemon-runtime/daemon-content/daemon-core-a~k）：自报 done 待复核 code-comment 文件 247 个仍含≥3行纯英文注释，集中在 `packages/cli/test/*.test.ts`、`packages/daemon/test/*.test.ts`（Top：bundle-routes.test.ts 293、send.test.ts 200、progress-review-done-coherence.test.ts 170、restore-packet.test.ts 166…）。注意测试名/断言为行为检查，只译注释与人类可见文本，不改断言语义、不删测试。
- **TUI**（owner: tui）：漏登 text-width.ts（优先）；注释层英文残留=0，但用户可见英文字面量仍残留（`execution-model.ts` 的 "Slack observation"/"Review"/"Integration decision" 显示映射未全覆盖），需逐屏复核 + 实际渲染截图目视中文宽度/截断。
- **Web UI**（owner: ui-a/ui-b/ui-c）：无 tracked 漏登；注释层英文残留=0，重点复核 `packages/ui/src/components/**` 用户可见字符串（标签/按钮/空态/tooltip/错误提示），需实际渲染目视。

## 6. 长文 doc 伴随版完整性抽查（12 篇，防摘要伪完成）
- 结构正常：CHANGELOG.md(2868→2391, 标题297/297)、cli-reference.md(1934→2316)、SKILL.md(1386→1185,85/85)、rig-spec.md(580→535)。
- 行数比偏薄、需 docs owner 逐篇复核：public-what-you-can-do.md(0.36)、v0.3.3.md(0.41)、v0.3.4.md(0.47)、SKILL.md(packages-c/extras,0.46)。
- 抽读 workflow-runtime.md（0.27）：**所抽段落信息完整（含代码引用/行号/事务步骤），未见摘要替换；但非逐段全审，不能据此称全文验收**。行数比单独不可靠。
- 以上 12 篇为结构/行数比对，非逐段全审，不构成全文完成验收。

## 7. 本轮台账实改（我作为唯一写者）
- **实改文件数（台账层面）= 2 条记录新增**：text-width.ts→tui(pending)、zrig-entry.test.mjs→entry(pending)。产品源码 0 改动。
- **状态转移**：pending 0→2；done/validated 未升任何记录。
- **局部增量（不代表全文完成）**：daemon-core-f 的 profile-resolver.ts、mission-control-read-layer.ts 由修改者做局部修复，20:47 独立回归 42 测试用例通过（profile-resolver.test.ts 34/34 + mission-control-read-layer.test.ts 8/8；统一称"测试用例"非"断言"）。我仅以锁脚本追加该回归证据 note，**未改 status/validation_state**；这两文件 notes 自述"本轮未覆盖，仍需翻译"却标 validated，存在内部矛盾，已上报待裁定。

## 8. 遗留风险
1. 1968 条 self_reported + 952 条历史验证标记均未对照现版本验收；不得整批降级或升 done，需各区逐条复核后由我统一改 validation_state。
2. text-width.ts 是 CJK 宽度/截断风险点，TUI 优先。
3. 分区交叉已按规则排除 vendored `packages/cli/daemon/specs`（不修改副本）；若需纳入请明示。
4. 测试文件英文残留须区分"需译注释"与"保留断言语义"。
5. 基线已实跑（build/tsc/help 通过，未跑测试/视觉），不能据此升 done。

## 9. 产物路径
- 项目核查目录：`/Users/bytedance/openrig/.codex/translation/review-2026-10-08/`（snapshot-2026-10-08.md、zone-gaps.json、本报告）
- 我的 artifacts：`.../agents/s_000cae4sF5G/artifacts/review-2026-10-08/`（audit_readonly.py、snapshot.json、_records.zeropoint-3062.json、tui/entry.zeropoint.json）
