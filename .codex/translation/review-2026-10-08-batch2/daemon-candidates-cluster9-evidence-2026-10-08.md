# daemon self-reported CLUSTER9 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/domain/**`（排除已审 180）。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 结论
20 源审读：16 已全中文无残留；4 处中英混排（db/数据库 handle → 数据库句柄）已修。

## 文件清单（路径 + sha256 前16 + 改动）
| # | 路径 | sha256 | 备注 |
|---|---|---|---|
| 1 | domain/restore-plan-preview.ts | 059f4a525502d9f2 | |
| 2 | domain/restore-topology.ts | d834046b7a6824e3 | |
| 3 | domain/resume-metadata-refresher.ts | 9a543fbbf7f64be6 | |
| 4 | domain/resume-token-capture.ts | 1addab85098eb3e3 | |
| 5 | domain/resume-token-validation.ts | 540b5b7f66cb67cf | |
| 6 | domain/rig-expansion-service.ts | e0fb57de42f35217 | |
| 7 | domain/rig-lifecycle-service.ts | 0d98c4d8f169c6c4 | **改 L153-154 db handle→数据库句柄** |
| 8 | domain/rig-status-compose.ts | 6134e1c53ab27f5e | |
| 9 | domain/rig-teardown.ts | 34e024c208ef1ef8 | |
| 10 | domain/rigspec-exporter.ts | ddd2fe48b95d00d4 | **改 L24/27 数据库 handle→数据库句柄** |
| 11 | domain/rigspec-instantiator.ts | 28cfb17e43c72a55 | **改 L44/47 db handle→数据库句柄** |
| 12 | domain/route-timing-recorder.ts | b3ec3ea15c04a5ab | |
| 13 | domain/running-name-guard.ts | 91485cdde1f6a5ea | |
| 14 | domain/runtime-verifier.ts | c5baa4ead23d6aab | |
| 15 | domain/slow-op-recorder.ts | ba4cfe14b2f66bb0 | |
| 16 | domain/self-attach-service.ts | 8a67c0245fa9924d | **改 L104-105 数据库 handle→数据库句柄** |
| 17 | domain/service-orchestrator.ts | a3ab8bfaa804f648 | |
| 18 | domain/services-readiness.ts | cb0d8259a73a5ca7 | |
| 19 | domain/shadow-capture.ts | 4b8779d59dc77107 | |
| 20 | domain/shell-classifier.ts | 19b279aef57e7157 | |

## 改动明细（均 db/数据库 handle → 数据库句柄）
- rig-lifecycle-service.ts L153-154（2处）
- rigspec-exporter.ts L24/27（2处）
- rigspec-instantiator.ts L44/47（2处）
- self-attach-service.ts L104-105（2处）
配套测试 rigspec-exporter.test.ts L249 正则同步为完整中文串（保组件语义）。

## 机器分类（保留英文不译）
- 协议：docker compose 状态、EnvReceipt、RigServicesSpec/Record、resume-token（ID 形/PATH 形）
- 组件：RigLifecycleService / RigSpecExporter / RigInstantiator / SelfAttachService / ServiceOrchestrator
- 引用：zrig up --existing/--plan、OPR 编号、PL 切片

## 验证请求
- 改动源：rig-lifecycle-route.test.ts（已 36 过）、seat-lifecycle-service.test.ts、rigspec-instantiator.test.ts、rigspec-exporter.test.ts
- 其余 16 未改源：相关全套覆盖，日志关联后台账 validated。
