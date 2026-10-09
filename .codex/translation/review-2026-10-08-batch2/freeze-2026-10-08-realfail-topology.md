# 展示文本断言失配修复冻结单（batch2 三修 / daemon topology-launcher）

日期：2026-10-08
范围：`packages/daemon/test/topology-launcher.test.ts`。仅同步断言自然语言子串；保留机器 id/传输枚举与行为语义。

## 根因
产品展示串已中文化，测试仍断言旧英文子串。

## 修改
1. L279：`toContain("unknown host id 'nope'")` → `toContain("未知主机 ID 'nope'")`。
   - 源码 hosts-registry-reader.ts:238 `未知主机 ID '${id}'。${idsHint}`；保留机器 id `nope`。
2. L289：`toContain("cannot carry remote rig-up")` → `toContain("主机 'ssh-only' 使用传输方式 'ssh'，无法承载远程工作组启动")`。
   - 源码 hosts-registry-reader.ts:252；保留 host id `ssh-only`、传输枚举 `ssh` 与 remote rig-up（无法承载远程工作组启动）行为语义，不只匹配"无法"。
3. L284 用例标题 `ssh transport placement …` → `ssh 传输放置 …`。

## 协议说明
- 未用宽泛 /中文.*/；机器 id `nope`/`ssh-only` 与传输 `ssh` 原样保留。
- 行为断言（status=failed/skipped、trace.calls 空）未动。

## 请求定向复验（由 s_000cae4sfcS 串行运行）
- packages/daemon/test/topology-launcher.test.ts

---

## 追加：walk-consumption-primitives.test.ts（同批）

### 修改
- L410：`message: expect.stringContaining("multiple")` → `expect.stringContaining("多个 Codex 线程")`。
  - 源码 current-generation-record.ts:223 `${sessionTarget} 的存活窗格下存在多个 Codex 线程`（sessionTarget=%42）。
  - 保留机器 error code `record_identity_unverified`、HTTP 409、pane `%42` 行为语义。

### 请求复验
- packages/daemon/test/walk-consumption-primitives.test.ts
