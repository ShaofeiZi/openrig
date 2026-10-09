# 定向复验冻结单 — 2026-10-08（真实失败修复）

范围：仅修复验证者 b2-04 / b2-10 日志报回的展示文本断言失配。产品文案已中文化、测试仍断言旧英文；**保留行为断言，仅同步展示文本子串**，未触碰任何 API/JSON 键、错误码、枚举、env/HTTP 路径、机器前缀。未跑构建/tsc/测试（由 s_000cae4sfcS 串行执行）。

## 修改文件（3，均为本轮已快照）

### 1. packages/daemon/test/restore-plan-preview.test.ts（2 处）
- L76：`/Claude session picker/` → `/Claude 会话选择器/`
  - 对应源码 `domain/restore-plan-preview.ts:117` = `"预计会出现 Claude 会话选择器（完整会话续接）"`。
- L99：`/Codex auth/` → `/Codex 认证/`
  - 对应源码 `domain/restore-plan-preview.ts:118` = `"预计续接前会进行 Codex 认证/更新检查"`。
- 行为断言保留：仍断言 `runtimePrompt` 命中对应运行时的续接提示。

### 2. packages/daemon/test/rigspec-routes.test.ts（3 处）
- L239：`/rigSpecExporter.*same db handle/` → `/rigSpecExporter.*同一个数据库句柄/`
- L251：`/rigInstantiator.*same db handle/` → `/rigInstantiator.*同一个数据库句柄/`
- L263：`/rigSpecPreflight.*same db handle/` → `/rigSpecPreflight.*同一个数据库句柄/`
- 对应源码（startup/createApp 接线）实际抛错：`createApp：rigSpecXxx 必须共享同一个数据库句柄`。
- 行为断言保留：仍断言 db 句柄不匹配时 createApp 抛错。

### 3. packages/daemon/test/rigspec-preflight.test.ts（1 处，根因已追）
- L395：`e.includes("not found")` → `e.includes("未找到")`；**保留** `e.includes("nonexistent")`。
- 根因（非协议污染）：`rigspec-preflight.ts:343-346` 经 `resolveNodeConfig` 透传 `profile-resolver.ts:118` 的
  `在 spec "<name>" 中未找到 Profile "nonexistent"。可用：…`，preflight 再前缀 `dev.impl: `。
  - `"nonexistent"` 是夹具 profile 名字面量，仍在错误串中（机器/夹具边界，保留）。
  - `"not found"` 是人类展示词，已本地化为 `"未找到"`（同步此子串）。
- 行为断言保留：仍断言缺失 profile 时 ready=false 且 errors 点名该 profile。

## 请定向复验的测试文件（仅此 3 个）
1. `packages/daemon/test/restore-plan-preview.test.ts`（b2-04：原 2 failed）
2. `packages/daemon/test/rigspec-routes.test.ts`（b2-10：原 3 failed）
3. `packages/daemon/test/rigspec-preflight.test.ts`（b2-10：原 1 failed）

期望：b2-04 该文件 11 用例全绿；b2-10 rigspec-routes 30 用例全绿、rigspec-preflight 30 用例全绿。

## 未覆盖 / 保留项
- queue.test.ts 注释/用例标题批被本真实失败打断，增量保留（约 50/78 标题已翻），**未回滚**，待复验通过后继续。
- 其余 zone-gap 注释批（bundle-routes/restore-packet/daemon-lifecycle）未动。
- 本单不改任何生产源码；仅同步测试展示文本。
