# CLI src 审读证据 — new-scope clusterB（2026-10-08 batch2）

范围：`packages/cli/src/commands/**`（续 clusterA 之后 30 个），排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| cli/src（非 generated/vendor） | 161 | 60（clusterA 30 + clusterB 30） | 101 |
| daemon/src（非 domain/generated/vendor） | 209 | 0 | 209 |

## 结论
30 源均早已全中文（头部 doc、console.error/log 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | commands/down.ts | e09f4ab42d8c4d39 |
| 2 | commands/env.ts | 338375db5a15e66b |
| 3 | commands/expand.ts | c2a8184d85f32911 |
| 4 | commands/export.ts | 1dce9478eac91b9f |
| 5 | commands/file.ts | 89ef2b928d3fe650 |
| 6 | commands/fork.ts | ecde1845f680840c |
| 7 | commands/gateway.ts | ce228455b2ce53e7 |
| 8 | commands/grow.ts | 57b4d8f623ce7725 |
| 9 | commands/health.ts | 6419fda4edb7b09d |
| 10 | commands/heartbeat.ts | 774520efc31f4da5 |
| 11 | commands/host.ts | a9af55b36620258e |
| 12 | commands/import.ts | 705dae428e2c158a |
| 13 | commands/launch.ts | 71b9b3adeb6b328c |
| 14 | commands/mcp.ts | ef9e200410fe3607 |
| 15 | commands/package.ts | bf0c32dd86ee4449 |
| 16 | commands/parked.ts | 9e5b315c95fac10d |
| 17 | commands/plugin.ts | 8ea2c05a7f3007d9 |
| 18 | commands/policy.ts | c9c062a0a7fe462d |
| 19 | commands/preflight.ts | 775de0f22ee5f8e0 |
| 20 | commands/project.ts | 3e1cf6bc4aaefc19 |
| 21 | commands/project-jev.ts | 505b9bac07c2cd3e |
| 22 | commands/project-worker.ts | b8bf4f5d18da9e53 |
| 23 | commands/proof.ts | 69ac8ba76f67edc9 |
| 24 | commands/provider.ts | f83f64e87a327910 |
| 25 | commands/ps.ts | 507acf76e9a9721b |
| 26 | commands/queue.ts | fe55a5beb1499b58 |
| 27 | commands/reconcile-session.ts | 628e8cab502d2766 |
| 28 | commands/release.ts | bdcc7048e7c1ed7d |
| 29 | commands/remove.ts | 64beb6b2c112f6b8 |
| 30 | commands/requirements.ts | 21d48326b3ae57f2 |

## 机器分类（保留英文不译）
- 协议：SENDER_FALLBACK/resolveSenderSession、res.data["fallbackDestination"]、res.data.errors/error、snapshotId/kind/mode/ageMs、`--rig`/`--node`/`--pod`/`--new-pod`/`--needs-human true|false` 机器标志
- 引用：OPR.0.4.4.13/0.4.3.05/0.3.4.3、B7 RULING-rig-mode-rig-policy-naming、hosts.yaml、`rig proof show`、`rig policy`、`rig plugin`
- env：heartbeat L131 RIGX_SHARED_DOCS_ROOT（机器 env 保留英文）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
