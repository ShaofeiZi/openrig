# 展示文本断言失配修复冻结单（batch2 / b2-28 + b2-31 复跑）

日期：2026-10-08
范围：仅 `packages/cli/test/**`。仅同步测试断言里与产品展示串失配的自然语言子串；保留全部行为断言与机器值。

## 失败来源
- b2-28-cli-chunk2.log：cross-host-http、daemon-bind-provenance（2 例）。
- b2-31-cli-chunk3.log：gateway-human-lifecycle-verb（1 例）。

## 修改清单

### 1. packages/cli/test/cross-host-http.test.ts（4 处断言同步）
- 产品展示串源码：`packages/cli/src/commands/send.ts:721/791`、`whoami.ts:413` 输出 `[经由主机=${host.id}（${hostDisplayTarget(host)}）]`。
- 原断言 `/via host=vps-b|经由 host=vps-b/` 与产品现串 `[经由主机=vps-b（…）]` 失配。
- 改为 `/经由主机=vps-b/`。host id `vps-b` 为机器 token，原样保留。

### 2. packages/cli/test/daemon-bind-provenance.test.ts（2 处）
- 源码 `packages/cli/daemon-lifecycle.ts:512` reason=`缺少必需监听器：检测到 tailscale 接口时…`。
  - L79 `/listener/i` → `/监听器/`。
- 源码 `packages/cli/daemon-lifecycle.ts:531` reason=`无法检查 ${indeterminate} 的监听器状态（瞬时探测失败）…`。
  - L118 `.toMatch(/indeterminate|could not be checked/i)` → `.toMatch(/无法检查/)`。
- 保留机器值：L117 `expect(r.ok).toBe("indeterminate")`、L118 守卫 `if (r.ok === "indeterminate")`、L80 `/tailscale/i`（接口专名）均未动。

### 3. packages/cli/test/gateway-human-lifecycle-verb.test.ts（1 处）
- 源码 `packages/cli/src/commands/gateway.ts:234` 输出 `投递就绪状态：${r.deliveryReadiness.state}（…）`，state 机器值为 `ready`。
- 原断言 `/投递( readiness)?[=：].*ready/` 与现串 `投递就绪状态：ready` 失配。
- 改为 `/投递就绪状态[：:].*ready/`。
- 保留机器值：L171 `expect(output).toContain("indeterminate")` 未动。

## 协议说明
- 未用宽泛 `/中文.*/`；仅把断言自然语言子串对齐产品现串，机器就绪值/枚举/专名原样保留。
- 行为断言（toMatch/状态判定/JSON 结构）语义不变。

## 请求定向复验（由 s_000cae4sfcS 串行运行）
- packages/cli/test/cross-host-http.test.ts
- packages/cli/test/daemon-bind-provenance.test.ts
- packages/cli/test/gateway-human-lifecycle-verb.test.ts
