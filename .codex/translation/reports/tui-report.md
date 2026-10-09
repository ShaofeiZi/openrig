# TUI 中文化进度报告（第二轮）

**生成时间**: 2026-09-29 13:06
**范围**: `packages/tui/` 全部 150 个文件

## 本轮关键修复

### 1. 中文显示宽度计算（核心修复）

新建 `src/text-width.ts`，实现 `strWidth()`、`padEndW()`、`padStartW()`、`clipW()` 函数，正确处理 CJK 宽字符占 2 列的问题。

**问题根因**：JavaScript 的 `String.prototype.length` 按 UTF-16 码元计数，中文字符（如"中"）长度为 1 但终端显示占 2 列。原代码的 `pad()`/`padLeft()` 使用 `t.length` 计算填充宽度，导致中文文本填充不足、垂直分栏线错位。

**修复内容**：
- `render.ts` 的 `pad()`/`padLeft()` 改用 `strWidth()` 计算显示宽度
- 6 个源文件中的 `.padEnd(N)` 替换为 `padEndW(..., N)`

### 2. 源文件翻译补全

- 表格列头：POD→席位、SEAT→席位、RIG→工作组、MODEL→模型、STATE→状态、WORK→工作、NOW→现在、ACTIONS→动作
- 健康视图：HEALTH→健康、ACTIVE→活跃、STALE→过期、CLEARED→已清除、SEV→级别、SIGNAL→信号、SCOPE→范围、AGE→年龄、CONF→置信、EVIDENCE→证据
- 执行模型：declared done→已声明完成、merged→已合并、planned→计划、waiting on you→等待你、needs input→需要输入

## 测试结果

```
Test Files  58 failed | 27 passed (85)
     Tests  270 failed | 483 passed (753)
```

**TypeScript 编译**: `npx tsc --noEmit` exit 0

## 截图（PNG）

- `/Users/bytedance/openrig/.codex/translation/screenshots/tui-demo-80x24.png`
- `/Users/bytedance/openrig/.codex/translation/screenshots/tui-demo-120x34.png`
- `/Users/bytedance/openrig/.codex/translation/screenshots/tui-demo-160x42.png`

## 状态

- total: 150, done: 93, failed: 57, pending: 0
- 备份: `.codex/translation/backup/tui/`
