# 增量验证（batch2）摘要 — 2026-10-08

- 与已验 301（review-2026-10-08）完全独立，不覆盖其结果。
- 约束不变：单 worker、--no-file-parallelism、隔离 HOME、nice、串行、每批 ≤5min。

## 测试文件分母（21:18 普查）

| 工作区 | 文件数 |
|---|---|
| daemon | 734 |
| cli | 195 |
| ui（tsx 154 + ts 44） | 198 |
| tui | 86 |
| scripts(node:test) | 29 |
| **合计** | **1242** |

## 覆盖进度

- 历史已验：21 文件 / 301 用例（见 review-2026-10-08/results.json）。
- batch2-01：11 个 scripts 守卫 / **92 用例通过 / 0 失败**（21:19:12–21:19:24，12s，rc=0）。
  日志：`verification-logs/b2-01-scripts-guards.log`
  （check-docs-guard / mirror-skills / generate-context-packs / check-internal-leak-guard /
  internal-leak-scanner / cli-license / typecheck-order / check-engines /
  rewrite-daemon-imports / sync-scope-lineage / portability-report）
- 当前累计覆盖：32 / 1242 文件。**不声称全量。**

## 待排批次（拟，按不受当前修改影响优先）

1. CLI 入口/JSON 边界：bin-wrapper / front-door / version-build-info / workflow-errors
2. daemon 高风险核心（需确认与 CLI 者当前改动不重叠）
3. TUI 机器字段（待 TUI 者 dropW/columnIndex 冻结）
4. UI 其余组件测试（待 UI 者 GUI fixture 冻结）

未跑原因：其余 1210 文件当前由修改方在改或未冻结，避免测中变动产生假败。

## 增量批次进度（21:24）

| 批次 | 范围 | 文件 | 用例 | 失败 |
|---|---|---|---|---|
| b2-01 | scripts 守卫 | 11 | 92 | 0 |
| b2-02 | cli 入口/JSON 边界 | 13 | 199 | 0 |
| b2-03 | daemon schema/spec/scope | 33 | 334 | 0 |
| b2-04 | daemon crash/mission/restore | 31 | 535 | 2 |
| b2-05 | tui text-width+render-regressions（dropW/columnIndex 冻结复跑） | 2 | 18 通过 | 4 |
| b2-06 | daemon activity/bundle | 30 | 366 | 0 |

新增覆盖：120 文件；含历史累计 141/1242。

### 待转原作者的精确失败（未改任何断言）
1. daemon/test/restore-plan-preview.test.ts:76 — 期望 /Claude session picker/，实得中文"预计会出现 Claude 会话选择器（完整会话续接）"（源码已中文化，测试正则未更新）。
2. daemon/test/restore-plan-preview.test.ts:99 — 期望 /Codex auth/，实得"预计续接前会进行 Codex 认证/更新检查"（同上）。
3. tui/test/text-width.test.ts ×4 — ReferenceError：dropW×2、columnIndex×2 未定义；
   源码 text-width.ts:85/:111 已导出这两个函数，判断为新测试文件漏 import，非源码缺失。
| b2-06 | daemon activity/bundle | 30 | 366 | 0 |
| b2-07 | daemon gateway/slack | 32 | 262 | 0 |
| b2-build-tui | TUI dist 重建（供 GUI 离线 renderScreen fixture） | — | rc=0，2s（21:25:11，dist/text-width.js 已更新） | — |

新增覆盖：174 文件；含历史累计 195/1242。
