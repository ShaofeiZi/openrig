# Verifier 报告 — TUI 中文化（机器枚举修复后）

**日期**: 2026-09-29 13:55
**基线**: 245 failed / 508 passed

## 1. TypeScript 编译

```
npx tsc --noEmit → exit 0 ✅
```

## 2. 测试结果

```
npx vitest run → exit 1
Test Files:  56 failed | 29 passed (85)
Tests:       239 failed | 514 passed (753)
```

| 指标 | 修复前 | 修复后 | 变化 |
|------|--------|--------|------|
| 失败测试 | 245 | **239** | -6 |
| 通过测试 | 508 | **514** | +6 |
| tsc | exit 0 | exit 0 | ✅ |

完整日志: `/Users/bytedance/openrig/.codex/translation/reports/tui-test-log.txt`

## 3. 本轮修复：机器枚举误译回退

共回退 **92 处** 机器协议枚举值为英文（20+10+6 = 36 个文件）：

| 中文误译 | 正确英文 | 出现次数 | 字段类型 |
|----------|----------|----------|----------|
| "活跃" | "active" | ~30 | status/state/lifecycleState |
| "已阻塞" | "blocked" | ~15 | state/queue_state/intendedAction |
| "完成" | "done" | ~20 | state/status/phase/exit |
| "工作中" | "working" | ~10 | pickup.state/activity |
| "等待" | "waiting" | ~8 | status/exit/category |
| "不可用" | "unavailable" | ~9 | freshness.state/availability/visibility |

涉及文件：hydrate.test.ts, execution-view.test.ts, entry-loading.test.ts, mission-outcomes.test.ts, slack-print-link.test.ts, presentation-guidance.test.ts, crash-cart-restore-lifecycle.test.ts, crash-cart-restore-render.test.ts, instance-mission-control.test.ts, founder-live-qa-correction.test.ts, slack-manifest-connections.test.ts, health-view.test.ts, startup.test.ts, startup-connection.test.ts, workflow-journey.test.ts, feed-source-continuity.test.ts, config-model.test.ts, config-journey.test.ts, live-events.test.ts, slack-manifest-connections.test.ts

**未改动**：展示层中文断言（expect/toBe/toContain 中的中文）保持不变。

## 4. 剩余 239 个失败原因

| 类别 | 约数 | 说明 |
|------|------|------|
| 旧英文显示断言 | ~100 | 测试期望英文，源码已渲染中文 |
| 宽度对齐偏移 | ~60 | strWidth 修复改变了填充空格数 |
| hit-map 坐标偏移 | ~40 | hitMap 坐标因宽度变化偏移 |
| 正则表达式 | ~30 | 测试中正则标签未同步中文 |
| 深度相等 | ~15 | 数组/对象中文标签不同 |

## 5. text-width 模块

- 源码: `/Users/bytedance/openrig/packages/tui/src/text-width.ts`
- 导出: `strWidth()`, `padEndW()`, `padStartW()`, `clipW()`
- 被 7 个源文件引用

## 6. 台账

```
tui  total=150  done=94  failed=56  pending=0
```

## 7. 截图

PNG 仍为修复前版本，未基于新代码重新生成。
