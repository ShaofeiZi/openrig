# 冻结：5 个 daemon 展示断言失配修复

日期：2026-10-08
均为产品展示串已中文化、测试仍断言旧英文；保行为/机器值，只同步自然语言子串。

## 修复清单
1. attention-aggregator.test.ts:121 — `unknown host id 'ghost'` → `未知主机 ID 'ghost'`（源 hosts-registry-reader.ts:238）。
2. discovery-routes.test.ts:304 — `/discoveryRepo.*same db handle/` → `/discoveryRepo.*必须共享同一个数据库句柄/`（源 claim-service.ts:116，保组件名 discoveryRepo）。
3. down-route.test.ts:70 — `/teardownOrchestrator must share the same db handle/` → `/teardownOrchestrator 必须共享同一个数据库句柄/`（源 server.ts:460，保组件名 teardownOrchestrator）。
4. hosts-registry-parity.test.ts:108-109,122 —
   - `unknown host id 'nope'` → `未知主机 ID 'nope'`；
   - `Known host ids: a` → `已知主机 ID：a`（源 hosts-registry-reader.ts:234）；
   - `cannot carry remote rig-up` → `无法承载远程工作组启动`（源 hosts-registry-reader.ts:252）。
5. ps-projection：
   - 测试 94：`/\d+[smhd]/` → `/\d+\s*(天|小时|分钟|秒|s|m|h|d)/`（源 formatDuration >24h 输出 "X天 Y小时"）；
   - 源 ps-projection.ts formatAge：`${dur} ago` → `${dur}前`（用户可见）；
   - 测试 105：`toContain("ago")` → `toContain("前")`。

## 机器值保留
ghost/known/nope/a/ssh-host/http-host/rig/transport url/bearer_env 等 fixture 字面量与组件名均未动；仅同步自然语言子串。

## 请定向复验
- packages/daemon/test/attention-aggregator.test.ts
- packages/daemon/test/discovery-routes.test.ts
- packages/daemon/test/down-route.test.ts
- packages/daemon/test/hosts-registry-parity.test.ts
- packages/daemon/test/ps-projection.test.ts
- 改动生产源：packages/daemon/src/domain/ps-projection.ts
