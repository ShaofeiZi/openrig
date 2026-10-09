# 计数口径更正（2026-10-08 21:05 修订）

- 所有"通过数"为 **vitest/node:test 报告的测试用例数（it/test 块）**，
  **不是独立断言（assertion）数**。reporter 不输出逐断言计数。
- **distinct 口径**：同一文件复跑只按最终一次结果计；不叠跑。

## 各工作区 distinct 最终状态（截至 t06）

| 工作区 | 文件 | 用例 | 状态 |
|---|---|---|---|
| daemon | profile-resolver.test.ts | 34 | 通过 |
| daemon | mission-control-read-layer.test.ts | 8 | 通过 |
| daemon | progress-review-done-coherence.test.ts | 20 | 通过 |
| ui | mission-status-badge.test.tsx | 10 | 通过 |
| ui | bundle-inspector.test.tsx | 10 | 通过（含新错误前缀断言，t04 实跑） |
| ui | package-list.test.tsx | 11 | 通过（含旧版包失败+HTTP 500 断言，t04 实跑） |
| ui | mission-status-surfaces.test.tsx | 9 | 通过 |
| ui | workspace-portfolio.test.tsx | 6 | 通过 |
| ui | project-workspace-overview.test.tsx | 6 | 通过 |
| ui | build-setup-prompt.test.ts（未跟踪，补登记） | 1 | 通过 |
| cli | send.test.ts | 73 | 通过 |
| scripts(node:test) | zrig-entry.test.mjs | 5 | 通过（node --test --test-concurrency=1） |
| tui | hydrate.test.ts | 35 通过 / 1 失败 | **失败：test:516 中文"不可用"过滤期望 1 条实得 2 条** |
| tui | config-model.test.ts | 4 | 通过 |
| tui | execution-view.test.ts | 26 | 通过 |
| tui | actions.test.ts | 7 | 通过 |
| tui | workflow-journey.test.ts | 2 | 通过 |
| tui | render-regressions.test.ts | 13 | 通过 |
| tui | parity.test.ts | 4 | 通过 |
| tui | parity-content.test.ts | 10 | 通过 |

**合计 distinct：294 用例通过 / 1 用例失败（总 295）。**

- UI t04 的 21 = bundle-inspector 10 + package-list 11，独立日志确认通过。
- t05 修正：1+36+4+26+7 = 74（其中 hydrate 1 失败）。
- 待办：hydrate 失败转 TUI 作者修；text-width ANSI 新发现待追加；
  全部修复后按一次串行跑 build + 四包 tsc + 三入口 JSON 兼容，不重复全量测试。
