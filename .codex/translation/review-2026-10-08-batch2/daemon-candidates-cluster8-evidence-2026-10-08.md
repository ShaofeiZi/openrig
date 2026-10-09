# daemon self-reported CLUSTER8 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/domain/**`（排除已审 160）。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 结论
20 源审读：19 已全中文无残留；1 处中英混排已修（seat-lifecycle-service.ts L166-167 db handle → 数据库句柄）。

## 文件清单（路径 + sha256 前16 + 改动）
| # | 路径 | sha256 | 备注 |
|---|---|---|---|
| 1 | domain/seat-handover-planner.ts | 09cff0f7c1777744 | |
| 2 | domain/seat-identity-store.ts | 6d9d3de5f4a2c11a | |
| 3 | domain/seat-lifecycle-service.ts | 5802e58a0e849e6f | **改 L166-167 db handle→数据库句柄** |
| 4 | domain/seat-status-service.ts | 2adec08ec3ca9a16 | |
| 5 | domain/seat-structural-activity-service.ts | 6cc5421607de26a8 | |
| 6 | domain/seat-switch-client-service.ts | 18eb58d7052cd05a | |
| 7 | domain/session-enricher.ts | 9cde8e348c8c15a6 | |
| 8 | domain/session-fingerprinter.ts | 59c3ec48b8b73978 | |
| 9 | domain/session-jsonl.ts | cb7b4547fa494bab | |
| 10 | domain/session-name.ts | a087b80bab2647d5 | |
| 11 | domain/session-registry.ts | c28d20be17ec33d0 | |
| 12 | domain/session-source-rebuild-resolver.ts | bef65735a6622eea | |
| 13 | domain/session-transport.ts | 68c48b4b9ffad91e | |
| 14 | domain/snapshot-capture.ts | 0477bd3bdbaac73d | |
| 15 | domain/snapshot-repository.ts | c5bc7c1968a9ceae | |
| 16 | domain/sync-site-wrap.ts | ee39a0989f596cc3 | |
| 17 | domain/tmux-discovery-scanner.ts | e033fbd509775729 | |
| 18 | domain/tmux-option-defaults.ts | 812212f4e19ed256 | |
| 19 | domain/types.ts | bc8112a4d67b3dd8 | |
| 20 | domain/user-settings/settings-store.ts | d021e0338e2aca22 | |

## 改动明细
- seat-lifecycle-service.ts L166-167：`必须共享同一个 db handle` → `必须共享同一个数据库句柄`（2处；throw 仅 db 句柄不匹配时触发）。

## 机器分类（保留英文不译）
- 命名格式：{pod}-{member}@{rig}、r{NN}-{suffix}
- 协议：transcript_path / rollout_path / wake / committedOutboxIds / OutboxHandler
- 组件：SeatLifecycleService / SessionRegistry / SessionTransport / SnapshotCapture / SettingsStore
- 引用：@openrig/cli ConfigStore / zrig config / USER settings v0

## 验证请求
- seat-lifecycle-service.ts 改动：建议复验 packages/daemon/test/seat-lifecycle-service.test.ts。
- 其余 19 未改源：相关全套覆盖，日志关联后台账 validated。
