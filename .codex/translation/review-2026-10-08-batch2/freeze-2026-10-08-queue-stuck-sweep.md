# 冻结：queue-stuck-sweep 命令串失配修复

日期：2026-10-08
失败：packages/daemon/test/queue-stuck-sweep.test.ts:228 期望 body 含 `OPENRIG_URL=<registered-host> rig queue show`，实得 `…zrig queue show…`。

## 根因
- 源码 `verificationCommand`（queue-stuck-sweep.ts:267）已按规范改为 `OPENRIG_URL=<registered-host> zrig queue show <id>`（命令示例人类可见层用 zrig，env/path 保留）。
- 测试 228 行仍断言旧英文时代的 `rig queue show`。
- 另有源码 284 行人类命令示例 `rig queue update` 未与 267 行统一为 zrig。

## 修复（保行为/机器协议）
- 测试 228 行：`rig queue show` → `zrig queue show`（对齐源码正确命令）。
- 源码 284 行：`rig queue update` → `zrig queue update`（人类命令示例统一；无测试断言此串）。
- 保留不动：499 行 `evidenceRef: rig queue show <id>`——机器内部引用（测试用 `slice("rig queue show ")` 解析查表，159/185 行断言），属机器协议，不改。
- 保留测试语义：230 行 `not.toMatch(/请解决底层 row|重写历史 row/i)`（诚实报告本地缺失、不附修改历史指令）未动。

## 请定向复验
- packages/daemon/test/queue-stuck-sweep.test.ts（重点 228 行附近用例 + 全文件回归）
- 改动生产源：packages/daemon/src/domain/queue-stuck-sweep.ts
