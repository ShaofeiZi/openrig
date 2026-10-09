# daemon non-domain 审读证据 — cluster2（剩余 surfaces + routes 前 15，2026-10-08 batch2）

范围：`packages/daemon/src/{剩余顶层 surfaces, routes 前 15}`，排除 domain/**/generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| daemon/src 非 domain/generated/vendor | 209 | 40（cluster1 20 + cluster2 20） | 169 |
| cli/src | 161 | 161（已收口） | 0 |

## 结论
20 源均早已全中文（头部 doc、throw 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | seat-recap-store-surface.ts | 4522e55bdd4c6bf8 |
| 2 | skill-loadout-surface.ts | e492582908ece1c0 |
| 3 | spec-conformance-surface.ts | bf79070ca2fa5f8 |
| 4 | stream-classifier-surface.ts | ce0369f02787c868 |
| 5 | system-world-surface.ts | 2310e6375f01d797 |
| 6 | routes/activity.ts | 9d2ee0c8ad349abf |
| 7 | routes/adapters.ts | 3fe72c434b79e170 |
| 8 | routes/agent-images.ts | 535daf59cb7ca70f |
| 9 | routes/agents.ts | 81cd2e9c3f2b5270 |
| 10 | routes/ask.ts | 3f4c36a0107310b0 |
| 11 | routes/attention.ts | 8e854cd7487d5f72 |
| 12 | routes/bootstrap.ts | a1bdd8515f572c61 |
| 13 | routes/bundles.ts | eec1e24af3d305bd |
| 14 | routes/chat.ts | cdadc5397e1bca8f |
| 15 | routes/compaction.ts | 06ec886292ea2bca |
| 16 | routes/config.ts | 36fe90c67ba9d931 |
| 17 | routes/context-packs.ts | ff78b352c3828e67 |
| 18 | routes/crash-cart.ts | 9eb4d2bca72b5e2c |
| 19 | routes/discovery.ts | 3adf1aac6c36c234 |
| 20 | routes/down.ts | 7f5311c1570338e1 |

## 机器分类（保留英文不译）
- 协议：Hono、streamSSE、better-sqlite3 Database、TmuxAdapter、DeliveryGuardError
- 引用：OPR.0.5.3.5 mini-req 7、PL-016 Starter Agent Images v0、PL-014 Rig Context/context_packs v0、B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21 content-hash 84401cd4
- 机器串：routes/attention "队列仓库不可用"、bundles "bundle 缺 bundle.yaml"（已中文）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
