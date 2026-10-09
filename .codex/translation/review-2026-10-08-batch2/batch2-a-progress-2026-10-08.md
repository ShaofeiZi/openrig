# 批次进度单 — 2026-10-08（注释翻译批 batch2-A）

说明：本批为注释/用例标题翻译，**纯行为中性**（不改运行时、不改断言、不动机器协议）。英文注释 before→after 为自定启发式（行首 `//`/`*`/`/*` 且含 ≥3 连续 ASCII 词），与台账 top 计数不可相减。未跑测试（由 s_000cae4sfcS 串行执行）。

## 已确认（上一冻结单复验回执）
- 3 个断言失配文件独立复跑 **71/71 用例通过**（restore-plan-preview 11、rigspec-routes 30、rigspec-preflight 30）。展示文本同步修复精准、保行为，已确认。

## 本批改动文件

### 1. packages/cli/test/queue.test.ts —— 整文件完成（done）
- `it()` 用例标题：78 个全部中文化（保留 `--body/--body-file/--mission/--slice/--gate/X-OpenRig-Session/nudge: false/api/queue/*/previewBody/resolveQueueBody` 等机器 token）。
- 注释：英文注释启发式残留 **before≈69 → after 0**。
- 保留：S4b RED / S03 / OPR.x / FR-x / PL-004 / R1 / P21 等编号标记、fixture 字面量、EISDIR 等机器串。
- 快照：`.../snapshot-2026-10-08/packages/cli/test/queue.test.ts`。

### 2. packages/daemon/test/bundle-routes.test.ts —— 部分完成（非 done，不报整文件 done）
- 已译：文件头/T4 篡改校验/T11-AS-T12 v2 pod 感知/兼容性与出处 camelCase 往返/符号链接安全预扫(B1)/rig_name 冲突闸门/force 绕过/无冲突/rig_spec traversal 验证器拒绝 等区块注释与若干标题。
- 启发式残留英文注释：**约 98 行**（集中在 1090 行之后的 audit 记录、skills/plugins/workflow_specs/context_packs 路由、跨原语 vendor、symlink 逃逸正负用例等区块）。
- 行为中性，未动任何断言。

## 未覆盖（如实列）
- bundle-routes.test.ts 剩余 ~98 行英文注释——下一批继续。
- packages/cli/test/restore-packet.test.ts（zone-gap 166）——本轮未开始。
- packages/cli/test/daemon-lifecycle.test.ts（zone-gap 127）——本轮未开始。
- send.test.ts：上一轮已收尾（见 BATCH2 报告）。

## 请定向复验（本批唯一整文件完成、行为中性）
- `packages/cli/test/queue.test.ts` —— 仅注释/标题翻译，期望用例数与断言全不变（原用例集应整体通过）。
- bundle-routes.test.ts 为部分注释翻译，可随下一批合并验证，本批不单独要求。

## 台账动作（请 s_000cae4sF5G 记录）
- queue.test.ts：code-comment，本批整文件审读+翻译完成（自报 done，待验证）。
- bundle-routes.test.ts：code-comment，in_progress（约译半，残留 ~98 行）。
