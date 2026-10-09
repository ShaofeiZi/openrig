# 冻结：server.test.ts(7) + service-orchestrator.test.ts(1) 展示断言修复

日期：2026-10-08
均为产品展示串已中文化、测试仍断言旧英文；保行为/机器值/code，只同步自然语言子串。

## server.test.ts（7 处 db handle 校验）
每处按特定组件名 + `必须共享同一个数据库句柄` 精准（源 server.ts:415-463）：
- 228：`/same db handle/` → `/必须共享同一个数据库句柄/`
- 242：`/snapshotRepo.*same db handle/` → `/snapshotRepo 必须共享同一个数据库句柄/`
- 264：`/snapshotCapture.*same db handle/` → `/snapshotCapture 必须共享同一个数据库句柄/`
- 294：`/restoreOrchestrator.*same db handle/` → `/restoreOrchestrator 必须共享同一个数据库句柄/`
- 307：`/packageRepo.*same db handle/` → `/packageRepo 必须共享同一个数据库句柄/`
- 320：`/installRepo.*same db handle/` → `/installRepo 必须共享同一个数据库句柄/`
- 360：`/podInstantiator.*same db handle/` → `/podInstantiator 必须共享同一个数据库句柄/`

## service-orchestrator.test.ts（1 处 boot 等待回执）
- 327：`toContain("not healthy")` → `toContain("服务目标仍不健康")`（源 service-orchestrator.ts:111 `等待 N 秒后服务目标仍不健康：…`）。
- 保留机器 code `wait_timeout`（326 行 `result.code).toBe("wait_timeout")` 未动）。

## 机器值保留
组件名 snapshotRepo/snapshotCapture/restoreOrchestrator/packageRepo/installRepo/podInstantiator、机器 code wait_timeout、HTTP/TCP/service 目标 target/url/service name 均未动；仅同步自然语言子串。

## 请定向复验
- packages/daemon/test/server.test.ts
- packages/daemon/test/service-orchestrator.test.ts
