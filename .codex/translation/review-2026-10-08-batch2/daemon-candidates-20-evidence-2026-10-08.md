# daemon 候选 20 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/**` 运行时源，整文件审读注释 + 人类错误/日志串 + 机器边界。
机器协议不译：env 变量、taxonomy/枚举值、manifest 字段名、错误码、throw 透传 message、PR/commit 引用、组件名。

## 结论
20 源中仅 1 处真实自然语言修复：`activity-taxonomy.ts` L66 中英混排。
其余 19 源早已全中文（头部 doc 注释、人类错误串均译），无自然语言残留，未做机械改。

## 文件清单（路径 + sha256 + 处理）
| # | 路径 | sha256（前 16） | 处理 |
|---|---|---|---|
| 1 | packages/daemon/src/adapters/claude-code-adapter.ts | 2e059bc54b122317 | 已中文，无改 |
| 2 | packages/daemon/src/adapters/codex-runtime-adapter.ts | a7c5c9fffb247f9a54 | 已中文；PR #20321/#21615 引用为机器名保留 |
| 3 | packages/daemon/src/adapters/tmux.ts | 7208f48370014740 | 已中文（人类错误串中） |
| 4 | packages/daemon/src/domain/active-lens-store.ts | 08bac1e141d39752 | 已中文 |
| 5 | packages/daemon/src/domain/active-occupant.ts | 96b1ffa6e9d73ccb | 已中文 |
| 6 | packages/daemon/src/domain/activity-endpoint.ts | 65e5096849d929aec | 已中文 |
| 7 | packages/daemon/src/domain/activity-taxonomy.ts | f1ef83ad147ec5d6 | **修复 L66** |
| 8 | packages/daemon/src/domain/agent-activity-store.ts | 5b786b1590bafbb1 | 已中文 |
| 9 | packages/daemon/src/domain/agent-images/agent-image-library-service.ts | 47f7461a9db0f616 | 已中文 |
| 10 | packages/daemon/src/domain/agent-images/agent-image-types.ts | 5e85a5f08549a9a1 | 已中文 |
| 11 | packages/daemon/src/domain/agent-images/evidence-guard.ts | d0ab4ac21cdc9efc | 已中文 |
| 12 | packages/daemon/src/domain/agent-images/manifest-parser.ts | 9b8ba7ebe2567359 | 已中文 |
| 13 | packages/daemon/src/domain/agent-images/resume-token-discovery.ts | fe0bf93bb705fb6 | 已中文 |
| 14 | packages/daemon/src/domain/agent-manifest.ts | 1a4792667a9da1a0 | 已中文 |
| 15 | packages/daemon/src/domain/agent-preflight.ts | da82cfe487fc6e5 | 已中文 |
| 16 | packages/daemon/src/domain/agent-resolver.ts | dbceb44c4ad0797f | 已中文 |
| 17 | packages/daemon/src/domain/agent-starter-resolver.ts | d7a417775a60231f | 已中文 |
| 18 | packages/daemon/src/domain/applied-launch-observation-store.ts | 29ec2e9e71feb7fa | 已中文 |
| 19 | packages/daemon/src/domain/ask-service.ts | 7be8f072ac9abc9 | 已中文 |
| 20 | packages/daemon/src/domain/bind-plan.ts | cf524d7adb81a6a7 | 已中文 |

## 唯一改动：activity-taxonomy.ts L64-66
```
throw new Error(
  `"${activity}" 不是 taxonomy activity value（working | idle-at-prompt | unknown）——` +
  `surface 本地词汇必须在其 adapter 中映射，绝不直接渲染`,
);
```
- before: `surface-local vocabulary 必须在其 adapter 中映射，绝不直接渲染`
- after:  `surface 本地词汇必须在其 adapter 中映射，绝不直接渲染`
- 机器 token 保留：`working | idle-at-prompt | unknown`（taxonomy 枚举值）、`adapter`。
- 这是人类错误消息中英混排，仅译英文自然语言，未改行为/阈值/判定逻辑。

## 深度证据（depth = 审读到的粒度）
- 每个文件：头部 doc 注释块逐行读 + 全部 `throw new Error(` / `log(` 串扫描 + `//`/`*` 注释行英文自然语言过滤。
- 19 个"无改"文件：扫描结果为空或命中均为机器 token（env/字段名/枚举/PR 引用/透传 message）。
- 改动文件：仅 L64-66 一处中英混排。

## 验证请求
- activity-taxonomy.ts 为源码改动，需跑其直接引用测试：
  - packages/daemon/test/activity-taxonomy.test.ts
  - packages/daemon/test/activity-rejects.test.ts（L64-66 reject 路径）
  - 相关全套 coverage 映射由验证者决定（parked-query / idle-gate-qitem-policy / activity-adapter-rungs / activity-ingest-seam / activity-evidence-ladder 等引用者）。
- 未改的 19 源不单测，由相关全套覆盖，日志关联即可。
- tsc 最终由验证者串行跑。
