# TUI Batch-next2：text-width 边界澄清 + follow-up 模块复审

日期：2026-10-08 ｜ 范围 packages/tui/**。不改旧报告。

## 本批真实改动
1. text-width.ts clipW 注释更正：原"width<=0 直接给…"措辞过度。
   实际：strWidth(text)<=width 先早返回原文（空串/纯SGR/未超宽都走此路）；仅超宽时进循环，
   width<=0 才立即出 "…"（输出占1列，历史边界非正确契约）。
2. 调用证据：execution-model fitSegs / health-model fitLine 均 `room=Math.max(0,width)` 且
   循环 `room<=0 break`，clipW 实得 room>=1；render-pulse 已判 avail>0 → width0 实际不发生，不改 API。
3. test/text-width.test.ts 补边界：clipW(""/纯SGR/你好@width0) 现状锁定；columnIndex col0 前导SGR返回0。

## SGR 措辞更正
- 本文件保证仅 SGR 控制序列(\x1b[..m)整体，不泛化所有 ANSI 转义；组合符/补充平面外符号按现有区间。

## follow-up 模块复审（完整审读，无增量修改，如实记载）
| 文件 | 结论 |
|---|---|
| src/connections/connections-model.ts | 状态映射/字段标签全中文；zrig 命令为机器值保留 |
| src/health/health-model.ts | 健康/活跃/严重/警告/信息 全中文；clipW 调用 room>=1 |
| src/config/config-model.ts | 分类/键/值标签全中文；configLabel 展示 |
| src/execution/execution-model.ts | guidance 映射已完整，clipW room 有 guard |
| src/attention/attention-model.ts | 收件人/解除阻塞/范围 全中文 |
| src/state.ts | 导航标签中文；kind.toUpperCase()/namespace 为机器枚举值保留 |

无新增人可见英文残留；未做大撒替换。

## 测试清单（交唯一验证者）
- packages/tui/test/text-width.test.ts（本批边界+dropW/columnIndex SGR）
- 复跑 packages/tui/test/render-regressions.test.ts（columnIndex 定位路径）

## 未验证
真实终端截图目视未做；width0 为理论边界（调用方已 guard）。

## 已审文件 hash（交台账 s_000cae4sF5G；后续若再改源会防 hash 过期）
```
0584cc27bd441a77467207719de4c21a584668e5  src/text-width.ts          (本批改)
effa40fe14c15ca3a19a184cccd24d56a838af61  src/connections/connections-model.ts  clean
ffccf52956cee4fe79e274a2a921b6d530e5f57a  src/health/health-model.ts  clean
62f8d679146a452bb070983b2ceae687dab094ca  src/config/config-model.ts  clean
52b0133e52b6b3795fb842c06a32554f606739d3  src/execution/execution-model.ts  clean(guidance)
24406c8c0dd52508aa458e9c54bd4b60c7f7fa38  src/attention/attention-model.ts  clean
e6ad44c1bc2460dc6654ea00c442743e3bd64119  src/state.ts  clean(机器枚举保留)
8674c0991f7ffc21820ac7b2103b3c19d97ea10e  src/scopes/scopes-model.ts  clean
03311034d9cc1d9d93e8b6102bf6378cb20448f0  src/commands/registry.ts  clean
a9d2d7f822b11a1c73b3f87cbde37bb85f87ffd2  src/topology/render-graph.ts  clean
92eebc5170d51e91565d7b0ee8269b2d42d9204a  test/text-width.test.ts   (本批改)
```
人可见英文残留：0（运行时展示）。test fixture 内 machine 值(candidate_sha/edge delegates_to 等)按协议保留。
