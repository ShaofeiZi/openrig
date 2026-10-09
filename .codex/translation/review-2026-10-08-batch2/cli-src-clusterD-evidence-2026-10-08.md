# CLI src 审读证据 — new-scope clusterD（2026-10-08 batch2）

范围：`packages/cli/src/{commands 尾部, lib, 顶层入口, cross-host, daemon-lifecycle}/**`，排除 generated/vendor。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 进度 ledger
| 范围 | 可审分母 | 已审 | 待审 |
|---|---|---|---|
| cli/src（非 generated/vendor） | 161 | 120（A 30 + B 30 + C 30 + D 30） | 41 |
| daemon/src（非 domain/generated/vendor） | 209 | 0 | 209 |

## 结论
30 源均早已全中文（头部 doc、console.error/log 人类串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | commands/whoami.ts | 6fd567d9d097254c |
| 2 | commands/workflow-errors.ts | d907e248202eba11 |
| 3 | commands/workflow-follow.ts | 7e0a121007e66b56 |
| 4 | commands/workflow-render.ts | 57550fd19ba2cf8 |
| 5 | commands/workflow.ts | 21981f7cc97ef18f |
| 6 | commands/workspace.ts | bc9c1cc1e494f99f |
| 7 | lib/codex-auth.ts | d87003348428bea6 |
| 8 | lib/context-git.ts | fa6dc03b57f6daa5 |
| 9 | lib/context-install.ts | d72af4272b3297da |
| 10 | lib/file-transfer.ts | a8db898f5cee6192 |
| 11 | lib/path-safety.ts | 1ab5dd1e40002735 |
| 12 | lib/topology-trace.ts | 40512e34d80ee99e |
| 13 | lib/walk-consumption.ts | bf4454e6096350f9 |
| 14 | lib/work-install.ts | 2b4870ebf11f2d0f |
| 15 | ask-wake.ts | 2668c7632c3f4e74 |
| 16 | bin-wrapper.ts | dec1e41b8fb41872 |
| 17 | build-info.ts | cdce03bd66bc6d1e |
| 18 | cmux-config.ts | 72b6adb8e00370be |
| 19 | config-store.ts | 0570aee5a4d4b145 |
| 20 | context-resolve.ts | 074efa8281bd004f |
| 21 | cross-host-cli-helpers.ts | 21fc32297f89af2b |
| 22 | cross-host-executor.ts | 454afe1c5e8da2e1 |
| 23 | cross-host-target.ts | 78e06c2bfccc26e7 |
| 24 | cross-host-types.ts | 22c8150e893a2e68 |
| 25 | daemon-lifecycle-status.ts | ac7e3ae763537f45 |
| 26 | daemon-lifecycle.ts | c8cd1b7fe0f17508 |
| 27 | daemon-start-lock.ts | a939bb9709667593 |
| 28 | destroy-helpers.ts | cbad9d0c4e41bd41 |
| 29 | fetch-with-timeout.ts | b14c5ab16262baf5 |
| 30 | host-bindings.ts | 35920445b6ef9725 |

## 机器分类（保留英文不译）
- 协议：FailedStep 枚举 "none"/"ssh-unreachable"/"permission-gate"/"remote-daemon-unreachable"/"remote-command-failed"/"remote-command-not-found"、CrossHostResult/HostEntry/HostBindingsFile、FetchTimeoutError、statusGuardMessage.fact
- 引用：OPR.0.4.1.29/0.4.4.18/0.4.4.11 FR-6/0.5.3.6、Slice-03 Atom 6b、PL-007、exit 127/command not found、rsync argv 构造器
- 注释引用英文短语：config-store L748 "What the operator gets"（设计引用，保留）

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
