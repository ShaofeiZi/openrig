# CLI / Daemon 运行时中文化与兼容修复 — 本轮复核报告（2026-10-08）

执行者：s_000cae46UNk　范围：`packages/cli/**`、`packages/daemon/**`（+ 用户授权根测试 `scripts/zrig-entry.test.mjs`）
约束：仅译人可见自然语言；API/JSON 键、枚举、错误码、DB 值、env/HTTP 路径、包名、内部 rig 子命令保持英文机器兼容。未跑 build/typecheck/test（由 s_000cae4sfcS 串行执行）。

---

## 0. 口径说明（重要）

- 本报告"英文注释行 before→after"是**本轮自定启发式**：统计行首为 `//`/`*`/`/*` 且含 ≥3 个连续 ASCII 词的注释行。
- 该口径与台账 zone-gaps 的 top 计数（如 progress-review-done-coherence=170、send=200）**不一致**——台账口径包含测试标题、内联片段、人可见字符串等更宽集合。
- **两者不可相减**，不能由"200−149"推出"剩余 51"或"247 剩余 N"。未覆盖数量以台账 zone-gaps.json 为准。

---

## 1. 本轮实际审读 / 修改单位

| 文件 | 性质 | 本轮动作 | 英文注释（启发式 before→after） | 状态 |
|---|---|---|---|---|
| `packages/daemon/src/domain/profile-resolver.ts` | 生产源（真实回归） | 3 处英文人可读错误串中文化；保留 `skill_identity_conflict:` 机器前缀与全部插值 | 0→0（本为错误串） | **翻译完成**（34 用例绿） |
| `packages/daemon/src/domain/mission-control/mission-control-read-layer.ts` | 生产源（真实回归） | `nextAction`/`pendingHumanDecision` 展示串中文化；保留机器判断 `state==="blocked"`/`tier==="human-gate"` | 1→1（留存 SQL 注释行，机器） | **翻译完成**（8 用例绿） |
| `packages/daemon/test/progress-review-done-coherence.test.ts` | 测试（注释/标题） | 整文件注释、JSDoc、`it()` 标题、expect 失败消息中文化；sha256/md5、VM-006、V1–V8、RC1/RC2/AMB/INV/FS-1、状态枚举、`## Proof contract`、匹配串未动 | 117→0 | **翻译完成**（20 用例绿） |
| `scripts/zrig-entry.test.mjs` | 授权根测试 | 审读：已全中文（含 `用法：`、`zrig` 品牌断言），无需改；请台账补登记 | — | 审读无改动 |
| `packages/cli/test/send.test.ts` | 测试（注释/标题） | 部分：describe 名、头部注释、约 15 个 `it()` 标题中文化；大量内联英文注释未处理 | 153→149（启发式，非台账 200） | **部分 / needs_review**（勿报整文件 done）；已送定向验证 |

---

## 2. 静态等价证据（未跑测试）

对本轮快照（修改前）与现文件逐文件 `diff`，过滤注释 / `it(` / `describe(` 行后，剩余差异**仅为人可读字符串字面量**：

- profile-resolver.ts：3 个 `errors:[…]` 模板串；`skill_identity_conflict:` 前缀、`${profileName}`、`${spec.name}`、`${managed.id}`、`${existingPath}`、`${managed.sourceDir}`、`(err as Error).message` 全部原样。
- mission-control-read-layer.ts：2 个展示模板串；机器三元条件与 `??` 兜底键名 `blockedOn`/`priority`/`tier` 原样。
- progress-review-done-coherence.test.ts：仅 4 个 `expect(row,"<消息>")` 第二参数（人可读失败消息）；匹配器 `.toBeTruthy()/.toContain(CONT)/.toBe(true)/.toBe("qa-verdict")` 与 `CONT` 常量原样。
- send.test.ts：过滤后无非注释差异（仅 describe/it 标题字符串）。

结论：本轮为**纯翻译变更**，无功能 / 断言 / 协议改动；代码 token 与测试匹配串等价。

---

## 3. 验证结果（s_000cae4sfcS 已回）

- `daemon/test/profile-resolver.test.ts` — 34/34 用例
- `daemon/test/mission-control-read-layer.test.ts` — 8/8 用例
- `daemon/test/progress-review-done-coherence.test.ts` — 20/20 用例
- 合计 **62 用例**、退出码 0；机器前缀 / 插值 / 夹具断言未动。

---

## 4. 审读后判定"历史误标 translation_error、本轮复扫无残留人类英文"的文件

- `daemon/src/domain/health-passive-ceremony.ts`：`context.role` 英文串经下游 `health-context.ts:102` 的 `r.role.startsWith("slice authority")` **机器消费**，保持英文机器证据词表，不译。
- `daemon/src/domain/pod-repository.ts`、`rig-mode-store.ts`、`snapshot-repository.ts`、`mission-control-write-contract.ts`：注释与人可读消息已中文；英文仅剩 SQL / 标识符 / 枚举（机器）。

---

## 5. 未覆盖项（如实留，不为完成率硬改）

- `send.test.ts`：仍有大量内联英文注释未译（本轮仅 describe/头部/部分 it 标题）；保持 needs_review。
- zone-gap top 未动（以台账 zone-gaps.json 为准）：bundle-routes.test.ts、restore-packet.test.ts、daemon-lifecycle.test.ts、queue.test.ts、helpers/hermetic-env.ts、p34-terminal-closing-writers.test.ts、up.test.ts、scope-commands.test.ts、config-store-extended.test.ts、activity-motion-fold.test.ts、setup.test.ts、ps-compact.test.ts、plugin.test.ts。
- 同批 flagged 的 10 个测试文件本轮未审读：agent-starter-resolver / codex-profile-preflight / external-install-planner / human-route-enforcer / node-inventory / pi-session-identity-generation / precompact-hook / tmux-adapter / restore-check-service / project-worker-entry。

---

## 6. 台账待写动作（转 s_000cae4sF5G）

1. `profile-resolver.ts`、`mission-control-read-layer.ts`：可由 translation_error → **翻译完成**（附 62 用例绿）。
2. `progress-review-done-coherence.test.ts`：注释 / 标题翻译完成。
3. `scripts/zrig-entry.test.mjs`：补登记（entry 区根测试）。
4. `send.test.ts`：保持 needs_review（部分翻译，勿报整文件 done）。
