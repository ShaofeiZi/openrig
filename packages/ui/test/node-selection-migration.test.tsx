// V1 润色 slice 阶段 5.1 P5.1-1 + DRIFT P5.1-D2——“以抽屉承载席位详情”退役的
// 回归守卫（负向断言流程 #8）。
//
// 最初是阶段 5 P5-4 的负向断言：DrawerSelection 中旧版 'node' 类别已退役，改用
// 'seat-detail'。到 V1 润色阶段 5.1，又完全取代了“以抽屉承载 seat-detail”模式：
// 图、树、表都导航到规范的 /topology/seat/$rigId/$logicalId 中心页（LiveNodeDetails）。
// 按 content-drawer.md 第 23–34 行，抽屉表面仅用于内容查看器（qitem/file/sub-spec）。
//
// 本文件把旧 P5-4 负向断言扩展为 P5.1-D2 退役守卫：
//   - NodeDetailPanel.tsx 文件不存在
//   - SeatDetailViewer.tsx 文件不存在
//   - SeatDetailTrigger.tsx 文件不存在
//   - DrawerSelection 联合类型中不含 'seat-detail'
//   - DrawerSelection 联合类型中不含 'node'（沿用 P5-4）
//   - AppShell 中不存在 useNodeSelection 函数（别名已退役）
//   - RigGraph 节点点击使用 useNavigate，而非 setSelection/setSelectedNode

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const SHARED_DETAIL_DRAWER_PATH = path.join(SRC, "components/SharedDetailDrawer.tsx");
const APP_SHELL_PATH = path.join(SRC, "components/AppShell.tsx");
const RIG_GRAPH_PATH = path.join(SRC, "components/RigGraph.tsx");
const NODE_DETAIL_PANEL_PATH = path.join(SRC, "components/NodeDetailPanel.tsx");
const SEAT_DETAIL_VIEWER_PATH = path.join(SRC, "components/drawer-viewers/SeatDetailViewer.tsx");
const SEAT_DETAIL_TRIGGER_PATH = path.join(SRC, "components/drawer-triggers/SeatDetailTrigger.tsx");

describe("P5.1-D2 retirement regression: drawer-as-seat-detail removed", () => {
  it("NodeDetailPanel.tsx file does NOT exist (component retired)", () => {
    expect(existsSync(NODE_DETAIL_PANEL_PATH)).toBe(false);
  });

  it("SeatDetailViewer.tsx file does NOT exist (drawer wrapper retired)", () => {
    expect(existsSync(SEAT_DETAIL_VIEWER_PATH)).toBe(false);
  });

  it("SeatDetailTrigger.tsx file does NOT exist (trigger primitive retired)", () => {
    expect(existsSync(SEAT_DETAIL_TRIGGER_PATH)).toBe(false);
  });

  it("DrawerSelection union does NOT contain 'seat-detail' kind", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    const unionMatch = src.match(/export type DrawerSelection =[\s\S]*?\| null;/);
    expect(unionMatch).not.toBeNull();
    const unionBlock = unionMatch![0];
    expect(unionBlock).not.toMatch(/\{\s*type:\s*["']seat-detail["']/);
  });

  it("DrawerSelection union does NOT contain legacy 'node' kind (P5-4 preserved)", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    const unionMatch = src.match(/export type DrawerSelection =[\s\S]*?\| null;/);
    const unionBlock = unionMatch![0];
    expect(unionBlock).not.toMatch(/\{\s*type:\s*["']node["']/);
  });

  it("SharedDetailDrawer routing has NO 'seat-detail' branch", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    expect(src).not.toMatch(/selection\.type\s*===\s*["']seat-detail["']/);
    expect(src).not.toMatch(/selection\.type\s*===\s*["']node["']/);
  });

  it("AppShell.tsx no longer exports useNodeSelection function (alias retired)", () => {
    const src = readFileSync(APP_SHELL_PATH, "utf8");
    // 先移除注释，避免历史提及造成误报。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/export\s+function\s+useNodeSelection\s*\(/);
  });

  it("RigGraph uses useNavigate (NOT setSelectedNode / NOT setSelection seat-detail)", () => {
    const src = readFileSync(RIG_GRAPH_PATH, "utf8");
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    // 正向：存在 useNavigate 导入与调用。
    expect(src).toMatch(/import\s*\{[^}]*useNavigate[^}]*\}\s*from\s*["']@tanstack\/react-router["']/);
    expect(codeOnly).toMatch(/useNavigate\s*\(\s*\)/);
    // 负向：setSelectedNode 与 'seat-detail' setSelection 模式均已移除。
    expect(codeOnly).not.toMatch(/setSelectedNode/);
    expect(codeOnly).not.toMatch(/setSelection\s*\(\s*\{\s*type:\s*["']seat-detail["']/);
  });

  it("LiveNodeDetails.tsx renders the 2-tab Overview + Details body row (single canonical surface per slice 25)", () => {
    const src = readFileSync(path.join(SRC, "components/LiveNodeDetails.tsx"), "utf8");
    // V0.3.1 slice 25 前向修复 1——锚定判别值。旧正则
    // `/type\s+Tab\s*=\s*"overview"\s*\|\s*"details"/` 只匹配前缀，因此即使重新引入
    // 第三个标签页（如 `"overview" | "details" | "terminal"`）也不会失败。以下两个断言
    // 共同证明联合类型恰好只有两个成员：
    //   (1) 正向——声明在第二个成员后以 `;`（或 `\n`）结束，因此联合类型无法静默扩展；
    //   (2) 负向——文件顶层 Tab 声明位置不存在包含三个及以上成员的字符串联合类型。
    expect(src).toMatch(/type\s+Tab\s*=\s*"overview"\s*\|\s*"details"\s*;/);
    // 负向：旧版五标签字面量已移除。
    expect(src).not.toMatch(/"identity"\s*\|\s*"agent-spec"\s*\|\s*"startup"\s*\|\s*"transcript"\s*\|\s*"terminal"/);
    // 负向：不存在包含三个及以上字符串成员的 Tab 联合字面量，可捕获
    // `"overview" | "details" | "anything"` 这类静默回归。
    expect(src).not.toMatch(/type\s+Tab\s*=\s*"[^"]+"\s*\|\s*"[^"]+"\s*\|\s*"[^"]+"/);
    // FileReferenceTrigger 包装启动文件（保留 P5.1-1a）。
    expect(src).toMatch(/import\s*\{[^}]*FileReferenceTrigger[^}]*\}\s*from/);
    expect(src).toMatch(/<FileReferenceTrigger/);
  });

  it("SeatScopePage drops outer tabs and mounts LiveNodeDetails directly (DRIFT P5.1-D1)", () => {
    const src = readFileSync(path.join(SRC, "components/topology/ScopePages.tsx"), "utf8");
    // 精确定位 SeatScopePage 函数体，不检查文件级导入；其他表面仍会引用
    // SEAT_SCOPE_TABS 常量。
    const seatFn = src.match(/export function SeatScopePage\(\)\s*\{[\s\S]*?^}/m);
    expect(seatFn).not.toBeNull();
    const body = seatFn![0];
    // 席位工作范围不再使用外层 ScopeShell tabsNav；LiveNodeDetails 直接作为页面正文挂载。
    expect(body).not.toMatch(/SEAT_SCOPE_TABS/);
    expect(body).toMatch(/<LiveNodeDetails\s+rigId=/);
  });
});
