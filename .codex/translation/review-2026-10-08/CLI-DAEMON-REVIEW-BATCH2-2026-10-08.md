# CLI / Daemon 运行时中文化 — 第二批复核证据（2026-10-08，执行者 s_000cae46UNk）

范围：`packages/cli/**`、`packages/daemon/**`。约束同前：仅译人可见自然语言；API/JSON 键、枚举、错误码、env/HTTP 路径、包名、内部 rig 子命令、**测试 fixture/机器串/断言语义一律不动**。未跑 build/typecheck/test（s_000cae4sfcS 串行）。

## 1. 本批改/审单位

| 文件 | 动作 | 英文注释（启发式 before→after） | 非注释 diff | 状态 |
|---|---|---|---|---|
| `packages/cli/test/send.test.ts` | 全收尾：译 `//`/JSDoc 注释与 `it()/describe()` 标题；fixture、`--json` 断言、正则、env 名、路径、中文错误串未动 | 153→0 | 空（仅注释/标题字符串） | 翻译完成（已送定向验证） |
| `packages/daemon/test/agent-starter-resolver.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/codex-profile-preflight.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/external-install-planner.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/human-route-enforcer.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/node-inventory.test.ts` | 审读 | 0→0（启发式误中"测试 13：…"） | — | 已中文，无改动 |
| `packages/daemon/test/pi-session-identity-generation.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/precompact-hook.test.ts` | 审读 | 0→0 | — | 已中文，无改动 |
| `packages/daemon/test/tmux-adapter.test.ts` | 审读 | 0→0 | — | 无改动（见下 fixture 说明） |
| `packages/daemon/test/restore-check-service.test.ts` | 审读 | 0→0 | — | 无改动（见下 fixture 说明） |
| `packages/cli/test/project-worker-entry.test.ts` | 审读 | 0→0 | — | 无改动（见下 fixture 说明） |

## 2. 5 处英文"字面量"为何不改（fixture，非产品文案）

- `tmux-adapter.test.ts:211` `"Command failed with exit code 127"`：桩造的子进程错误输出，模拟 shell 报错，非产品人类文案。
- `restore-check-service.test.ts:184/249` `"Daemon running on port 7433"`、`:240` `"Something is running but not the daemon"`：桩造的 `zrig status` stdout，作为解析器的受控输入；翻译会改变测试语义。
- `project-worker-entry.test.ts:160` `"Retain in the pool"`：桩值/日志 fixture。

以上属 fixture/机器串，按规则保持英文。

## 3. 口径说明（沿用第一批）

- "英文注释 before→after"为自定启发式（行首 `//`/`*`/`/*` 且含 ≥3 连续 ASCII 词），与台账 top 口径不同，**不可相减**。未覆盖数以台账 zone-gaps.json 为准。

## 4. 验证状态

- `packages/cli/test/send.test.ts`：已送 s_000cae4sfcS 定向验证（用例数/退出码待回）。
- 其余 10 个审读无改动，无需重跑。

## 5. 台账待写动作（转 s_000cae4sF5G）

- `send.test.ts`：由 needs_review→本轮注释/标题翻译完成。
- 10 个 flagged 测试：审读已中文/无残留产品文案，历史 translation_error 标记可复核关闭（fixture 英文保留）。
