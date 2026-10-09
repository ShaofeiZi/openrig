# 展示文本断言失配修复冻结单（batch2 二修 / b2-28 + b2-31 复验仍 fail）

日期：2026-10-08
范围：`packages/cli/src/commands/**`（展示层）+ `packages/cli/test/**`（断言同步）。
说明：上一轮把测试断言改成与产品现串对齐；复验仍 4 fail，根因是产品存在两个未统一的 host 横幅变体，且 gateway list 人类输出无 `投递就绪状态` 前缀。本轮按用户决策在展示层统一中文标签，再精准断言。

## 1. host 横幅统一（用户可见全简中；机器 host 字段数据不变）

### 根因
源码存在两个变体：
- `[经由 host=${host.id}（…）]`：broadcast.ts:212、capture.ts:185/230、transcript.ts:159（英文 host）。
- `[经由主机=${host.id}（…）]`：whoami.ts:413、send.ts:721/791（中文 主机，带 =）。

### 展示层修复（统一为 `[经由主机 ${host.id}（…）]`）
- broadcast.ts:212、capture.ts:185/230、transcript.ts:159、whoami.ts:413、send.ts:721/791。
- capture.ts:198 注释同步为 `[经由主机 …]`。
- host id（vps-b / vm-a）为机器数据，原样保留；仅把中文标签统一为「经由主机」并去掉 `=`。

### 测试断言同步
- cross-host-http.test.ts（4 处）：`/经由主机=vps-b/` → `/经由主机 vps-b/`。
- cross-host-commands.test.ts:90（send 路径）：`toBe("[经由主机=vm-a（vm-a.local）]")` → `toBe("[经由主机 vm-a（vm-a.local）]")`。
- cross-host-commands.test.ts:260（capture 路径）：`toBe("[经由 host=vm-a（vm-a.local）]")` → `toBe("[经由主机 vm-a（vm-a.local）]")`。

## 2. gateway human 就绪状态断言（保机器 ready/indeterminate）

### 根因
- list 人类输出（gateway.ts:211）为紧凑行：`…类别=B 可用 绑定数=…  投递=${state}`，无 `投递就绪状态` 前缀。
- show 人类输出（gateway.ts:234）为详情块：`投递就绪状态：${state}（…）`。
- 原断言 `/投递就绪状态…ready/` 只匹配 show，不匹配 list 紧凑行。

### 修复（断言同时覆盖两种真实渲染，验证机器 state 语义）
- gateway-human-lifecycle-verb.test.ts:174：`/投递就绪状态[：:].*ready/` → `/投递(就绪状态)?[=：].*ready/`。
  - list 紧凑行 `投递=ready`：`投递` + 省略 `就绪状态` + `[=：]`=`=` + `.*ready` 命中。
  - show 详情行 `投递就绪状态：ready`：`投递` + `就绪状态` + `[=：]`=`：` + `.*ready` 命中。
- 机器值保留：该分支仅在 detail=null（state=ready 的 happy path）触发；indeterminate 用例走既有分支断言 `toContain("indeterminate")` + `entry.detail` + `下一步：zrig status`，未动。
- 未改 gateway.ts 展示层：紧凑行已含 `投递=${state}`（ready/indeterminate 机器枚举英文），详情块已含 `投递就绪状态：${state}`；断言验证的是 readiness 机器值语义，不只是「类别/可用」。

## 协议说明
- 未用宽泛 `/中文.*/`；host id 与 readiness 机器枚举（ready/indeterminate）原样保留。
- 行为断言语义不变；仅统一中文展示标签并让断言匹配真实渲染。

## 请求定向复验（由 s_000cae4sfcS 串行运行）
- packages/cli/test/cross-host-http.test.ts
- packages/cli/test/cross-host-commands.test.ts
- packages/cli/test/gateway-human-lifecycle-verb.test.ts
- daemon-bind-provenance.test.ts 上一轮已通过，本轮未改，无需复跑。
