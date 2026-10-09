# daemon non-domain 审读证据 — cluster1（top-level 入口 + surfaces，2026-10-08 batch2）

范围：`packages/daemon/src/{顶层入口, surfaces, db-path, compat, build-info}`，排除 domain/**/generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| daemon/src 非 domain/generated/vendor | 209 | 20（cluster1） | 189 |
| cli/src | 161 | 161（已收口） | 0 |

## 结论
20 源均早已全中文（头部 doc、console.error/log/warn 人类串均译），无自然语言残留，未做机械改。server.ts L415 已是"数据库句柄"（db handle 清零闭环）。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | index.ts | 8977b9283d65800d |
| 2 | startup.ts | 6053488640e87273 |
| 3 | server.ts | 59615e179782d786 |
| 4 | seed.ts | 1d38ffc6dd823928 |
| 5 | daemon-shutdown.ts | d692beca0f577dc |
| 6 | daemon-db-path.ts | 6c6ab9c2b855201b |
| 7 | openrig-compat.ts | 95607cec82257783 |
| 8 | build-info.ts | d6e772f4f066bc08 |
| 9 | attention-surface.ts | d7a24e0f3c599004 |
| 10 | context-pack-taxonomy-surface.ts | b770741dff2f7156 |
| 11 | crash-cart-surface.ts | bfc638f922e1d825 |
| 12 | gateway-human-registry-surface.ts | 7865b875a2efae59 |
| 13 | gateway-protocol-surface.ts | db1e1b32d0dad6a7 |
| 14 | gateway-slack-surface.ts | e9e91ad673ead6e |
| 15 | health-detectors-surface.ts | 718cdd057ae0cd5c |
| 16 | health-projection-surface.ts | f0675f1521b69274 |
| 17 | instance-initialization-surface.ts | 62d68735819efaf5 |
| 18 | local-reading-surface.ts | dc7585ce9aaa4993 |
| 19 | project-catalog-surface.ts | eede2a61027a5a43 |
| 20 | project-lifecycle-surface.ts | 9c07353ded5b2c7 |

## 机器分类（保留英文不译）
- 协议：@hono/node-server serve/ServerType、HEALTH_LIST_SCHEMA/HEALTH_CATEGORIES、FilePathSafetyError/ProjectReadError
- 引用：OPR.0.4.4.11 FR-6、OPR.0.5.6.10、M1 A5 gateway<->connector 线路编解码、S10 @openrig/daemon/gateway-slack、qitem-20260828092429-d2f94323 T2 desk 裁定
- 打包裁定：A 护栏 1、human-fragment 模式、registry 投影、relay 切换
- 错误串：server.ts "createApp：rigRepo 与 eventBus 必须共享同一个数据库句柄"（已中文闭环）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
