# daemon self-reported CLUSTER5 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/domain/**`（排除已审 100）。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 结论
20 源审读：19 已全中文无残留；1 处中英混排已修（package-install-service.ts L47 DB handle → 数据库句柄）。

## 文件清单（路径 + sha256 前16 + 改动）
| # | 路径 | sha256 | 备注 |
|---|---|---|---|
| 1 | domain/native-process-lineage.ts | 3b9e8d4d416daa53 | |
| 2 | domain/native-resume-probe.ts | 18a03a12eea7f431 | L307-310 引用 Codex 机器错误串保留英文 |
| 3 | domain/node-cmux-service.ts | 08a4b280082bb443 | |
| 4 | domain/node-inventory.ts | 1af6f8bdd5b3a5ad | |
| 5 | domain/node-launcher.ts | 1f60df722fbc5e91 | |
| 6 | domain/occupant-invalidator.ts | 948a7b46f58e7714 | |
| 7 | domain/outbox-handler.ts | e4cc86794d597727 | |
| 8 | domain/package-install-service.ts | 4e608caada4122ca | **改 L47 DB handle→数据库句柄** |
| 9 | domain/package-manifest.ts | 61dd3d5577539bcf | |
| 10 | domain/package-repository.ts | d64f1b8716b2f5f5 | |
| 11 | domain/package-resolve-helper.ts | 0b83dcedec56e6fa | |
| 12 | domain/package-resolver.ts | 9a74fd693424a27 | |
| 13 | domain/pane-binding-observation.ts | d210764929e4628e | |
| 14 | domain/parked-query.ts | e1b1c880e22c736c | |
| 15 | domain/projection-planner.ts | d594b47a2bb7b991 | |
| 16 | domain/path-safety.ts | 1ab5dd1e40002735 | |
| 17 | domain/periodic-snapshot-scheduler.ts | 56f4a5663690eb04 | |
| 18 | domain/permission-drift-observer.ts | 4f2b331586612001 | |
| 19 | domain/permission-drift.ts | ff3b83f82d45aa65 | |
| 20 | domain/plugin-discovery-service.ts | 4f51efb7ebb18dd2 | |

## 改动明细
- package-install-service.ts L47：`必须共享同一个 DB handle` → `必须共享同一个数据库句柄`（对齐其他组件中文措辞；throw 仅 db 句柄不匹配时触发）。

## 机器分类（保留英文不译）
- 引用机器串：Codex "Your access token could not be refreshed..."（native-resume-probe L307-310，须精确匹配 paneContent）
- 枚举/协议：AppliedLaunchAxis=permission|sandbox|resource_trust|not_applicable、PARKED 派生诊断、package.yaml
- 组件：NodeLauncher / OccupantInvalidator / PackageInstallService / ProjectionPlanner / PluginDiscoveryService
- throw 透传 message（外部原样）

## 验证请求
- package-install-service.ts 改动：建议复验 packages/daemon/test/bootstrap-orchestrator.test.ts（PackageInstallService 关联实例化）。
- 其余 19 未改源：相关全套覆盖，日志关联后台账 validated。
