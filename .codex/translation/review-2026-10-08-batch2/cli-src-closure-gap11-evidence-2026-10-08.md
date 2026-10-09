# CLI src 收口补遗 — authoritative gap-11（2026-10-08 batch2）

范围：台账权威差集 11 文件（`packages/cli/src/lib/permission-policy/*` + `lib/scope/*`），排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 收口 ledger（权威 union 去重）
- cli/src 非 generated/vendor 分母：**161**
- 此前 clusterA~E union：150（A 30 + B 30 + C 30 + D 30 + E 26 + 入口已含）
- 本批权威补：**11**
- 累计 union：**161 / 161，未审 0**

## 结论
11 源均早已全中文（头部 doc、人类错误串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | lib/permission-policy/policy-ref.ts | b3df5ebf9744e023 |
| 2 | lib/permission-policy/policy-spec.ts | 8531bf1ec80632a7 |
| 3 | lib/scope/capability-delta.ts | 2f39f7b58ca4c33b |
| 4 | lib/scope/dot-id.ts | 070eb6e6d4515bf4 |
| 5 | lib/scope/mission-composition.ts | bb37cf8e1fa5a78c |
| 6 | lib/scope/progress-edit.ts | 72a297e6ca135700 |
| 7 | lib/scope/scope-audit.ts | 295f904fb0655eae |
| 8 | lib/scope/scope-fs.ts | 8d718e684579e40d |
| 9 | lib/scope/templates.ts | aff03b2ff185403a |
| 10 | lib/scope/trust.ts | 0c2efe1ca43e715e |
| 11 | lib/scope/types.ts | b9a54dadd421428f |

## 机器分类（保留英文不译）
- 协议：permission_policy REF vs SPEC body、Slice03 README v4、dot-ID 语法（openrig-work/conventions/scope-and-versioning/README.md §1）、logical-checkbox `## Proof contract`、frontmatter YAML、git mv 包装
- 引用：OPR.0.4.8.3/0.5.0.18/0.4.0.33/0.4.1.6、release-0.3.2 slice 12、KI-5.3-2、release-0.4.7 intent-stage/scaffold-projection
- 类型：scope CLI 原语类型、capability-delta、attestation-lineage（canonical amendment-lineage）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。cli/src 权威 union 收口。
