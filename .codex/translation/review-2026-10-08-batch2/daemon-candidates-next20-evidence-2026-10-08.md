# daemon self-reported NEXT20 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/domain/**`（DAEMON-CANDIDATES-NEXT20 清单）。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 结论
20 源均早已全中文（头部 doc 注释、人类错误串均译），无自然语言残留，未做机械改。
无源码改动 → 不单测，由相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16 + depth）
| # | 路径 | sha256 | depth（审读粒度） |
|---|---|---|---|
| 1 | domain/bootstrap-orchestrator.ts | 8a4a9063d4ada8c9 | 头部 import 注释 + db 句柄错误串 |
| 2 | domain/bootstrap-types.ts | e4f3010d97abc41c | doc 注释全中文 |
| 3 | domain/builtin-policy-reference.ts | cc49b17f83bc7b38 | 头部 doc 中文 |
| 4 | domain/chat-repository.ts | 9e6278949a640282 | 无英文注释/串 |
| 5 | domain/checkpoint-store.ts | 34aae6df2f9981a8e | 无英文注释/串 |
| 6 | domain/claim-service.ts | eee6c1603532a857 | db 句柄错误串中文 |
| 7 | domain/classification-attempts.ts | 09aac04749ea9465 | 无英文注释/串 |
| 8 | domain/classification-sources.ts | 92dab9f9c96bb0c3 | 无英文注释/串 |
| 9 | domain/classifier-lease-manager.ts | ee59b244d5310f69 | 无英文注释/串 |
| 10 | domain/claude-activity-hooks.ts | 73bab7c8c73fca93 | 头部 doc 中文 |
| 11 | domain/claude-managed-launch.ts | 2d7d91bbe12f94b7 | 人类错误串中文 |
| 12 | domain/cmux-layout-service.ts | 849f64bc8c90fd0a | 头部 doc + 错误串中文 |
| 13 | domain/codex-daemon-support.ts | 95b8e31262243223 | 头部 doc 中文 |
| 14 | domain/codex-thread-id.ts | 70432d9434245f25 | 无英文注释/串 |
| 15 | domain/conflict-detector.ts | 535e418e90c57a01 | 无英文注释/串 |
| 16 | domain/context-monitor.ts | 0ced0a4feb2b2ccc | 无英文注释/串 |
| 17 | domain/context-packs/context-pack-library-service.ts | 852847757a87a724 | 头部 doc + 错误串中文 |
| 18 | domain/context-packs/context-pack-types.ts | 50f0ca997339dc3e | 头部 doc 中文 |
| 19 | domain/context-packs/manifest-parser.ts | ef4b471cfef1424e | 头部 doc 中文 |
| 20 | domain/context-packs/probe-eval-bridge.ts | 68fa8740eae529d0 | 头部 doc 中文 |

## 机器分类（保留英文不译）
- env：OPENRIG_* / RIGGED_* / OPENRIG_HOME / OPENRIG_URL / PATH / HOME
- 组件/服务名：CmuxLayoutService.computeLayout / BootstrapOrchestrator / ClaimService / ClassifierLeaseManager / ContextUsageStore / ClaudeCompactionEnforcer
- 机器协议：manifest.yaml / PL-014 / PL-016 / OPR 编号 / throw 透传 message / better-sqlite3 / ulid
- 错误码/枚举：bootstrap status（planned/running/completed/failed/partial）、db 句柄校验
- 引用：PR/commit/qitem 编号

## 深度证据
每个文件：头部 doc 注释块 + 全部 `throw new Error(` 串 + `//`/`*` 注释行英文自然语言过滤。
20 个文件扫描结果为空或命中均为机器 token。

## 验证请求
未改源，由相关全套覆盖（bootstrap/claim/classification/cmux/context-packs 等既有测试），日志关联后台账记 validated。
本轮唯一源码改动仍为 activity-taxonomy.ts L66（见上一份证据报告）。
