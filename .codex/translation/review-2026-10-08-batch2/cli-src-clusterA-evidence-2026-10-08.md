# CLI src 审读证据 — new-scope cluster A（2026-10-08 batch2）

范围：`packages/cli/src/**`（入口顶层 + commands 前 25），排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 新范围 scope ledger（精确）
| 范围 | tracked .ts | 可审分母 | 已审 | 待审 |
|---|---|---|---|---|
| daemon/src（非 domain/generated/vendor） | 209 | 209 | 0 | 209 |
| cli/src（非 generated/vendor） | 161 | 161 | 30（本批） | 131 |
| 合计 | 370 | 370 | 30 | 340 |

## 结论
30 源均早已全中文（头部 doc、console.error/log 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
### 入口顶层（5）
| # | 路径 | sha256 |
|---|---|---|
| 1 | src/index.ts | e19fe20afed3969 |
| 2 | src/front-door.ts | 93f6bca420a7aab5 |
| 3 | src/client.ts | 97bf5b9079a1d0b4 |
| 4 | src/cli-error.ts | 7700093220422207 |
| 5 | src/openrig-compat.ts | b750191eea04af2 |

### commands（25）
| # | 路径 | sha256 |
|---|---|---|
| 6 | commands/add.ts | 665684adcff4b34 |
| 7 | commands/adopt.ts | 634d17424b71dc0 |
| 8 | commands/agent-image.ts | 484a6de9ad72a45 |
| 9 | commands/agent.ts | 9fe096573ee20eac |
| 10 | commands/archive.ts | 546c24251bb08b17 |
| 11 | commands/ask.ts | 288f28e87356da45 |
| 12 | commands/attach.ts | fda8284550b7243d |
| 13 | commands/auth.ts | 9dd1678ba0dd45e4 |
| 14 | commands/bind.ts | 809b1e33a930d03d |
| 15 | commands/bootstrap.ts | f1b091c810269b35 |
| 16 | commands/broadcast.ts | 1e233a41d267a13e |
| 17 | commands/bundle.ts | a8092c9acc2f1a29 |
| 18 | commands/capture.ts | c068c1bc20a5a82c |
| 19 | commands/chatroom.ts | 941014314ea84600 |
| 20 | commands/compact-plan.ts | 1b61a6116a6a847f |
| 21 | commands/compact.ts | 9305e6b98b9485f5 |
| 22 | commands/config-init-workspace.ts | 038fbb859fe78d3f |
| 23 | commands/config.ts | 488386be463339ae |
| 24 | commands/context.ts | 5a83d33253e6d200 |
| 25 | commands/crash-cart.ts | ff089f218fd9e9ed |
| 26 | commands/create.ts | f88126a9ad003bc9 |
| 27 | commands/daemon.ts | 661e8dfd52b11870 |
| 28 | commands/destroy.ts | 0f7f535ac6362628 |
| 29 | commands/discover.ts | 5c4e7552aed0ad2f |
| 30 | commands/doctor.ts | 4292e57cada2b063 |

## 机器分类（保留英文不译）
- 协议：Commander 注册、--bind logicalId=tmuxSessionOrDiscoveryId、res.status===404、res.data.rigId、terminalAuthHeaders、zrig/CLI 子命令名
- 引用：OPR.0.4.1.29/0.4.7.15、PL-014/PL-016、Atom-7、Slice-17 mini-req 7、`rig context`/`rig agent-image` 机器动词
- 代码上下文：index.ts L221/L224 中文注释引用 Commander 英文默认串 "display help for command"（机器默认，注释中文）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
