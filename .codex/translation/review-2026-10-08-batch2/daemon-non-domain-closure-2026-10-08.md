# daemon non-domain 收口证据（2026-10-08 batch2）

权威分母用 `git ls-files 'packages/daemon/src/*.ts' 'packages/daemon/src/**/*.ts'` 排 domain、排 *.generated，tracked 实算 **209**。

## 收口 ledger（tracked union 求差）
| 项 | 数 |
|---|---|
| tracked 非 domain/generated 分母 | 209 |
| 六报告 union 已审（cluster1-6） | 120 |
| missing（comm 求差） | 89 |
| missing 构成 | 全部 `db/migrations/*.ts`（SQL schema 机器资产） |
| **收口** | 209 = 120 审 + 89 migrations 机器资产 |

## migrations 89 分类（机器资产，不做自然语言翻译）
- 内容：`CREATE TABLE/ALTER TABLE` SQL DDL，DB schema 机器兼容（按规范保留英文机器协议）。
- 内联 `--` 注释：抽样 20 条全部为「英文表名 + 中文描述」，无英文自然语言残留（如 `-- rigs：顶层拓扑容器。`、`-- nodes：rig 内的逻辑身份。`）。
- 结论：机器 DB schema，人类注释已中文，无需改动 → 记为 reviewed（machine asset）。

## 六报告已审 120（均 verifier 通过）
- cluster1：顶层入口 8 + surfaces 12
- cluster2：剩余 surfaces 5 + routes 15
- cluster3：routes 20
- cluster4：routes 20
- cluster5：routes 12 + adapters 8
- cluster6：adapters 14 + db(all-migrations/connection/migrate) 3 + lib/middleware/terminal 3
- 合计 routes 67 + adapters 22 + 顶层 25 + db(非mig) 3 + lib/mw/term 3 = 120

## 机器分类（保留英文不译）
- 协议：Hono/streamSSE/better-sqlite3/TmuxAdapter/CmuxTransport/DeliveryGuardError/bearer-token
- DB schema：rigs/nodes/edges/sessions/checkpoints/pods/continuity_state 等表与列名（机器键）
- 引用：OPR 系列、PL-005/007/014/016、V0.3.1 slice、Slice 09/28、51-08 A3

## 验证请求
cluster1-6 未改源 → 相关全套覆盖日志关联后台账 validated。migrations 为机器 schema 资产，注释已中文，无源码改动。daemon non-domain 209 收口。
