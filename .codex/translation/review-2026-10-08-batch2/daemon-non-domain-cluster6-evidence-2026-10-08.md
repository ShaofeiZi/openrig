# daemon non-domain 审读证据 — cluster6（adapters 尾 + db/lib/middleware/terminal，2026-10-08 batch2）

范围：`packages/daemon/src/{adapters 尾, db, lib, middleware, terminal}`，排除 domain/**/generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| daemon/src 非 domain/generated/vendor | 209（待复核实算） | 120（cluster1-6 各 20） | 89 |
| cli/src | 161 | 161（已收口） | 0 |

## 结论
20 源均早已全中文（头部 doc、throw 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。
注：db/ 实仅 3 文件（all-migrations/connection/migrate），非台账估计 92；builtins/ 顶层无 .ts。后续按实算口径收口。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | adapters/pi-runner-protocol.ts | 4e6bc3d598914c6a |
| 2 | adapters/pi-runner.ts | 865526d537ab8834 |
| 3 | adapters/pi-runtime-adapter.ts | 304aa6a7279efe6 |
| 4 | adapters/shell-quote.ts | 4b9c6ddeb9ef858 |
| 5 | adapters/stub-compaction.ts | 8bac2dae5201c7af |
| 6 | adapters/stub-restore.ts | 642f5c2d216c6a24 |
| 7 | adapters/stub-runner-protocol.ts | 22bab78c11f3803f |
| 8 | adapters/stub-runner.ts | 46b5de2e55b50b12 |
| 9 | adapters/stub-runtime-adapter.ts | 542e9c31bd672967 |
| 10 | adapters/stub-script.ts | f997f95e27fa573b |
| 11 | adapters/terminal-adapter.ts | a760e5a9d6e16f2e |
| 12 | adapters/tmux-exec.ts | b74b5d0d66588b63 |
| 13 | adapters/tmux.ts | 7208f48370014740 |
| 14 | adapters/yolo-mode.ts | 8e7f83d71bb4883a |
| 15 | db/all-migrations.ts | e3d52b2dce009f8d |
| 16 | db/connection.ts | 8911e77a4710802c |
| 17 | db/migrate.ts | c12b774e04dedb01 |
| 18 | lib/pane-envelope.ts | 8a160c06981b62fd |
| 19 | middleware/auth-bearer-token.ts | c4d0b9c50328e73b |
| 20 | terminal/TerminalSessionBroker.ts | c0aa4e33b4683557 |

## 机器分类（保留英文不译）
- 协议：better-sqlite3、TmuxAdapter、DeliveryGuardError/SeatDeliveryGuard、bearer-token、permissionMode 正则 `^[A-Za-z][A-Za-z0-9]*$`
- 引用：OPR.0.4.6.PI1、OPR.0.5.1.1 A5 第 6-8 项/ContextMonitor、OPR.0.4.8.2 YOLO 模式、V0.3.1 slice 23 founder-walk-queue-handoff-envelope、PL-005 阶段 B /api/mission-control/*、canonical 迁移 001→089
- 机器串：pi-runner "${flag} 需要一个值"、stub-runner "必须提供 --session-name"、tmux "私有探针目标已变化"、yolo-mode "Claude permission mode 无效"（均已中文）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
