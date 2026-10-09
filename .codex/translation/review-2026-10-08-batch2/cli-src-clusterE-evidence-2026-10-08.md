# CLI src 审读证据 — new-scope clusterE（2026-10-08 batch2）

范围：`packages/cli/src/{顶层入口, lib, release-surface, restore-packet, host/remote 支撑}/**`，排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger（cli/src 收口）
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| cli/src（非 generated/vendor） | 161 | **161 / 161** | **0** |
| daemon/src（非 domain/generated/vendor） | 209 | 0 | 209 |

## 结论
26 源均早已全中文（头部 doc、console.error/log 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。cli/src 非 generated 161 全部审读完毕，未审 0。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | host-registry.ts | dde963dad5576f5f |
| 2 | host-selection.ts | c79aed8ee3b1ff3 |
| 3 | local-origin.ts | ae6583c93b1096e0 |
| 4 | local-reading.ts | 92f10abb298d3095 |
| 5 | mcp-server.ts | 1431ea4186226dd0 |
| 6 | node-support.ts | e27c8dece14c2155 |
| 7 | read-view.ts | 6008afeb6ed6805b |
| 8 | remote-host-ops.ts | cecf8385739c7150 |
| 9 | sender-identity.ts | 769704146cbd5162 |
| 10 | session-name.ts | dc5da09137c24471 |
| 11 | shared-tui.ts | 738d6cdf1d9bb2ea |
| 12 | system-preflight.ts | a9317d7360aa7f4e |
| 13 | tmux-health.ts | 690244f5a32ac102 |
| 14 | version.ts | b419cee024e73a73 |
| 15 | release-surface/affected-skills.ts | 7586ccd84ad18dc7 |
| 16 | release-surface/extract-surface.ts | c5f4b7a85bb3b3ec |
| 17 | release-surface/generate.ts | b44985722584ae6f |
| 18 | release-surface/surface-diff.ts | 5250ae2cf8b72a9c |
| 19 | restore-packet/types.ts | 669ffcd01cdcba60 |
| 20 | restore-packet/schema-validator.ts | 2ba98319362dc668 |
| 21 | restore-packet/claude-transcript-parser.ts | 71289ff4822116c6 |
| 22 | restore-packet/codex-jsonl-parser.ts | 7db177149c915aad |
| 23 | restore-packet/omitted-records.ts | 423a598ac136a5a0 |
| 24 | restore-packet/packet-writer.ts | 779d62adb9e52267 |
| 25 | restore-packet/redaction.ts | 6aa83fce9762b734 |
| 26 | restore-packet/runtime-detect.ts | 6139d3305d15e52d |

## 机器分类（保留英文不译）
- 协议：McpServer/zod、TmuxProbeResult、StructuredTranscript、restore-summary.schema.json v0 JSON Schema、--source-jsonl 运行时检测、bearerAuthHeaders/classifyHttpFailedStep/HttpHostEntry
- 引用：OPR.0.4.6.MH1 FR-1/FR-8、OPR.0.3.3.13.1/13.2、M1 契约 §3.4/§5、check-abi.mjs postinstall 守卫
- 恢复包：v0 恢复包目录、原子写入、脱敏策略、4 种省略类别枚举

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。cli/src 收口。
