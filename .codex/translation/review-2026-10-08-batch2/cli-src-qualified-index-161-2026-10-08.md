# CLI src 全 161 qualified index by reports（2026-10-08 batch2）

本报告为 cli/src 非 generated/vendor 161 路径的权威收口索引，逐条映射到本轮证据报告，确保每 path 均有本轮 report 覆盖。

## 报告清单（均 verifier 通过）
| 报告 | 覆盖源数 | 状态 |
|---|---|---|
| cli-src-clusterA-evidence | 30（入口 5 + commands 前 25） | 本轮审 |
| cli-src-clusterB-evidence | 30（commands 30） | 本轮审 |
| cli-src-clusterC-evidence | 30（commands 30） | 本轮审 |
| cli-src-clusterD-evidence | 30（commands 尾 6 + lib 8 + 顶层/cross-host/daemon-lifecycle 16） | 本轮审 |
| cli-src-clusterE-evidence | 26（顶层支撑 14 + release-surface 4 + restore-packet 8） | 本轮审 |
| cli-src-closure-gap11-evidence | 11（permission-policy 2 + scope 9） | 本轮审 |
| CLI-SKIP-REVIEW 同伴本轮全文 4 | 4（lib/hosts/fanout-contract + scope 3） | 同伴审（台账 CLI-SKIP-REVIEW 引用） |
| **合计 union** | **146 + 11 + 4 = 161 / 161** | 收口 |

> 算式修正：A-D 120 + E 26 = 146（不是 150）；gap11 11 为本轮审；skip-review 4 引用同伴 CLI-SKIP-REVIEW 本轮全文审证据。三类状态不混。

## 同伴 CLI-SKIP-REVIEW 本轮全文 4（引用其证据，不重审）
| # | 路径 | sha256 前16 | 证据来源 |
|---|---|---|---|
| 1 | packages/cli/src/lib/hosts/fanout-contract.ts | d4f7e2317df86084 | 台账 CLI-SKIP-REVIEW 本轮全文审 |
| 2 | packages/cli/src/lib/scope/attestation-lineage.ts | b513f6c231ffbd7 | 台账 CLI-SKIP-REVIEW 本轮全文审 |
| 3 | packages/cli/src/lib/scope/logical-checkbox.ts | 32fb874457333dc6 | 台账 CLI-SKIP-REVIEW 本轮全文审 |
| 4 | packages/cli/src/lib/scope/scaffold-placeholder.ts | 8b6982ae70192781 | 台账 CLI-SKIP-REVIEW 本轮全文审 |

## 机器分类（补 4 保留英文不译）
- OPR.0.4.4.15 P4 扇出载荷契约（fanout-contract）
- OPR.0.5.0.18 canonical amendment-lineage 推导（attestation-lineage）
- KI-5.3-2 logical-checkbox `## Proof contract` / acceptance 复选框区块（logical-checkbox）
- release-0.4.7 intent-stage/scaffold-projection，`[a] and [b]` 模板占位语法（scaffold-placeholder）

## 收口声明
cli/src 非 generated/vendor 161 路径全部由上述报告 union 覆盖（A-D 120 + E 26 + gap11 11 + skip-review 4 = 161），未审 0。本轮审 146+11，同伴审 4，状态不混。无源码改动 → 相关全套覆盖日志关联后台账 validated。
