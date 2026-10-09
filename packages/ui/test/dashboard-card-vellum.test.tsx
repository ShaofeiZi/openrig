// Dashboard 源码级测试。
//
// OPR.0.4.1.14——Dashboard 路由现为 founder 锁定的 fidelity
// 刷新：paper-draft 启动器网格 + Field Environment + 起草 footer，
// 由 ./vellum/fidelity-glyphs.js + 作用域 ./dashboard-fidelity.css 构建。
// 旧大数字 vellum 原语（DestinationsLayer / TopLayerContent
// / VellumDestinationCard 等）不再被生产 dashboard 使用——
// 仅为 /lab/vellum-lab 设计实验保留。本测试验证 (a) Dashboard.tsx 组合新 fidelity
// 表面 + 接对真实数据 hooks，且 (b) 旧原语仍完整供 lab 用。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DASHBOARD_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/Dashboard.tsx"),
  "utf8",
);
const DESTINATIONS_LAYER_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/DestinationsLayer.tsx"),
  "utf8",
);
const TOP_LAYER_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/TopLayerContent.tsx"),
  "utf8",
);
const CARD_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/VellumDestinationCard.tsx"),
  "utf8",
);

describe("Dashboard (OPR.0.4.1.14 fidelity refresh)", () => {
  it("Dashboard.tsx composes the fidelity launcher surface", () => {
    // 新 fidelity 原语 + 作用域样式表。
    expect(DASHBOARD_SRC).toContain('from "./vellum/fidelity-glyphs.js"');
    expect(DASHBOARD_SRC).toContain('import "./dashboard-fidelity.css"');
    // Paper-draft 表面 + Field Environment + footer。
    expect(DASHBOARD_SRC).toContain("df-root");
    expect(DASHBOARD_SRC).toContain("FieldEnvironment");
    expect(DASHBOARD_SRC).toContain("DashboardFooter");
    // 旧大数字层组合已从生产 dashboard 消失（迁到仅 lab）。
    expect(DASHBOARD_SRC).not.toContain("DestinationsLayer");
    expect(DASHBOARD_SRC).not.toContain("TopLayerContent");
  });

  it("Dashboard.tsx declares all 6 destinations with their routes (no behaviour change)", () => {
    for (const route of ["/topology", "/project", "/for-you", "/specs", "/search", "/settings"]) {
      expect(DASHBOARD_SRC).toContain(`to: "${route}"`);
    }
    for (const num of ["01", "02", "03", "04", "05", "06"]) {
      expect(DASHBOARD_SRC).toContain(`num: "${num}"`);
    }
  });

  it("Dashboard.tsx wires real-data hooks for the Field Environment", () => {
    // OPR.0.4.1.14 功能细化：STATION/RIGS/AGENTS/OPERATOR 已是真实；
    // VERSION 是新真实接线（运行中 daemon 版本）。
    // active 子计数已弃（AGENTS 每行单一 live 计数）。
    expect(DASHBOARD_SRC).toContain("useRigSummary");
    expect(DASHBOARD_SRC).toContain("usePsEntries");
    expect(DASHBOARD_SRC).toContain("useSettings");
    expect(DASHBOARD_SRC).toContain("useDaemonVersion");
    expect(DASHBOARD_SRC).toContain("totalRigs");
    expect(DASHBOARD_SRC).toContain("totalAgents");
    expect(DASHBOARD_SRC).toContain("version");
    expect(DASHBOARD_SRC).toContain("hostname");
  });

  // ── 旧 vellum 原语——仅为 /lab/vellum-lab 保留 ──────────
  it("legacy DestinationsLayer still declares all 6 routes (lab primitive intact)", () => {
    for (const route of ["/topology", "/project", "/for-you", "/specs", "/search", "/settings"]) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`to="${route}"`);
    }
    for (const num of ["01", "02", "03", "04", "05", "06"]) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`num="${num}"`);
    }
  });

  it("legacy VellumDestinationCard keeps the numeral layout (lab primitive intact)", () => {
    expect(DESTINATIONS_LAYER_SRC).toContain('layout="numeral"');
    expect(CARD_SRC).toContain("NumeralLayout");
    expect(CARD_SRC).toContain("CornerBracket");
    expect(CARD_SRC).toContain("backdrop-blur-[10px]");
    expect(CARD_SRC).toContain("bg-surface-low/45");
  });

  it("legacy TopLayerContent keeps its classification chrome (lab primitive intact)", () => {
    expect(TOP_LAYER_SRC).toContain("欢迎回来");
    expect(TOP_LAYER_SRC).toContain("(s*)");
    expect(TOP_LAYER_SRC).toContain("Operator");
    expect(TOP_LAYER_SRC).toContain("Field Station");
    expect(TOP_LAYER_SRC).toContain("监视无处不在");
    expect(TOP_LAYER_SRC).toContain("backdrop-blur-[6px]");
  });
});
