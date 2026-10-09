# CLI src 审读证据 — new-scope clusterC（2026-10-08 batch2）

范围：`packages/cli/src/commands/**`（续 clusterB 之后 30 个），排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| cli/src（非 generated/vendor） | 161 | 90（A 30 + B 30 + C 30） | 71 |
| daemon/src（非 domain/generated/vendor） | 209 | 0 | 209 |

## 结论
30 源均早已全中文（头部 doc、console.error/log 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | commands/restore-check.ts | e71be7a31ce2237e |
| 2 | commands/restore-packet.ts | 87fe4036e494488e |
| 3 | commands/restore.ts | 2e2e128d610a8b7c |
| 4 | commands/rig-mode.ts | ead1e5d2b1e3fe56 |
| 5 | commands/rig.ts | d2f07802676d8db6 |
| 6 | commands/scope.ts | c7789237108b6e61 |
| 7 | commands/seat.ts | 3fb55f8e04bfe84c |
| 8 | commands/send.ts | 1bdca081cfed4d8f |
| 9 | commands/setup.ts | 38299d520a9d01dd |
| 10 | commands/shrink.ts | 7fbf7b22cb1e098e |
| 11 | commands/skill.ts | 35442cf27b45ba10 |
| 12 | commands/slack.ts | b2f19efdd5fe2fe8 |
| 13 | commands/snapshot.ts | 7050c6689fc66ebd |
| 14 | commands/specs.ts | 87f2d2bf2084f953 |
| 15 | commands/start.ts | 6f95d05a4de22de4 |
| 16 | commands/startup-proof.ts | 442b16e5461d96a3 |
| 17 | commands/status.ts | bdf543d961ce9ac5 |
| 18 | commands/stream.ts | fbbdae228d152187 |
| 19 | commands/terminal.ts | 0f5c04592a5f53bd |
| 20 | commands/topology-default-agent.ts | 720bba601706e407 |
| 21 | commands/transcript.ts | 04c675927eaf2741 |
| 22 | commands/tui.ts | c62fc8a42daf093f |
| 23 | commands/ui.ts | 0b13ae8ca79bad6 |
| 24 | commands/unarchive.ts | e55680f870b7aa6e |
| 25 | commands/unclaim.ts | 44e09de1a2431895 |
| 26 | commands/up.ts | 5cae2190fa0435f8 |
| 27 | commands/usage.ts | 72bab1112351c75d |
| 28 | commands/view.ts | f6b5d56913a4b6e6 |
| 29 | commands/walk.ts | 4cb4afc16fdd4c72 |
| 30 | commands/watchdog.ts | e42029e67edb505b |

## 机器分类（保留英文不译）
- 协议：terminalAuthHeaders、statusGuardMessage(status).fact、HOST_TOPOLOGY_REJECTION、UI_MAINTENANCE_NOTICE、--runtime claude-code|codex、--pace 单位后缀 10s/500ms、--policy context-usage-threshold、res.data["rigId"]/["logicalId"]/["sessionName"]/reroutedQitemIds
- 引用：OPR.0.3.4.1/0.3.2.9/0.4.6.02 C3/0.4.3.05、release-0.3.2 slice 12、Slice-03 Atom 6、51-08 A4、/api/telemetry/usage/* 路由
- 错误码：skill L65 invalid_runtime（机器码前缀保留）；rig-mode L215 中文注释引用表面串 "Daemon not running"

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
