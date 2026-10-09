// Operator Surface Reconciliation v0——steering composer 测试。
//
// 针对 fixture filesystem layout 驱动 SteeringComposer（workspaceRoot 包含 STEERING.md +
// roadmap/PROGRESS.md + delivery-ready/mode-{0..3}/PROGRESS.md）。固定以下行为：
//   - 至少一个 source 可解析时 isReady() 为 true；全部不可解析时为 false
//   - priority stack section 逐字返回 STEERING.md 内容
//   - roadmap rail 提取 checkbox row + railItemCode + isNextUnchecked
//   - lane rail 按 mode-N 分组；top-N item 优先非 done；首个非 done、非 blocked checkbox
//     标记 next-pull
//   - per-section override（steeringPath / roadmapPath / deliveryReadyDir）优先于
//     workspace-root 派生的默认值
//   - 不可用 source 呈现带 envVar hint 的结构化 diagnosis
//   - env 为空/未设置时，composer 的 isReady() 为 false

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SteeringComposer,
  matchRailItemCode,
  steeringOptsFromEnv,
  steeringOptsFromSettings,
} from "../src/domain/steering/steering-composer.js";

describe("Operator Surface Reconciliation v0——matchRailItemCode", () => {
  it("从任意文本中提取 PL-XXX code", () => {
    expect(matchRailItemCode("ship PL-019 topology indicators")).toBe("PL-019");
    expect(matchRailItemCode("PL-005 Phase A")).toBe("PL-005");
    expect(matchRailItemCode("no rail code here")).toBeNull();
  });
});

describe("Operator Surface Reconciliation v0——steeringOptsFromEnv", () => {
  it("env 未设置时返回 null workspaceRoot", () => {
    expect(steeringOptsFromEnv({})).toMatchObject({ workspaceRoot: null });
  });

  it("读取 OPENRIG_STEERING_WORKSPACE + per-section override", () => {
    const opts = steeringOptsFromEnv({
      OPENRIG_STEERING_WORKSPACE: "/abs/workspace",
      OPENRIG_STEERING_PATH: "/abs/override/STEERING.md",
      OPENRIG_ROADMAP_PATH: "/abs/override/roadmap.md",
      OPENRIG_DELIVERY_READY_DIR: "/abs/override/delivery-ready",
    });
    expect(opts.workspaceRoot).toBe("/abs/workspace");
    expect(opts.steeringPath).toBe("/abs/override/STEERING.md");
    expect(opts.roadmapPath).toBe("/abs/override/roadmap.md");
    expect(opts.deliveryReadyDir).toBe("/abs/override/delivery-ready");
  });

  it("OPENRIG var 为空时回退到 RIGGED_STEERING_WORKSPACE（使用 || 而非 ??）", () => {
    expect(steeringOptsFromEnv({ OPENRIG_STEERING_WORKSPACE: "", RIGGED_STEERING_WORKSPACE: "/legacy" }))
      .toMatchObject({ workspaceRoot: "/legacy" });
  });

  it("将 typed workspace setting 用作全新安装默认值，同时 env override 仍优先", () => {
    const opts = steeringOptsFromSettings(
      {
        workspaceRoot: "/Users/me/.openrig/workspace",
        workspaceSteeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
      },
      {},
    );
    expect(opts).toMatchObject({
      workspaceRoot: "/Users/me/.openrig/workspace",
      steeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
    });

    const overridden = steeringOptsFromSettings(
      {
        workspaceRoot: "/Users/me/.openrig/workspace",
        workspaceSteeringPath: "/Users/me/.openrig/workspace/steering/STEERING.md",
      },
      {
        OPENRIG_STEERING_WORKSPACE: "/env/workspace",
        OPENRIG_STEERING_PATH: "/env/STEERING.md",
      },
    );
    expect(overridden).toMatchObject({
      workspaceRoot: "/env/workspace",
      steeringPath: "/env/STEERING.md",
    });
  });
});

describe("Operator Surface Reconciliation v0——SteeringComposer", () => {
  let workspaceRoot: string;
  let cleanup: string;

  beforeEach(() => {
    cleanup = mkdtempSync(join(tmpdir(), "steering-composer-"));
    workspaceRoot = join(cleanup, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(cleanup, { recursive: true, force: true }));

  it("无可解析 source 时 isReady() = false（空 workspace + 无 override）", () => {
    const composer = new SteeringComposer({ workspaceRoot: null });
    expect(composer.isReady()).toBe(false);
  });

  it("至少一个 source 可解析时 isReady() = true（仅 priority stack）", () => {
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# steering");
    const composer = new SteeringComposer({ workspaceRoot });
    expect(composer.isReady()).toBe(true);
  });

  it("priority stack 逐字返回 STEERING.md 内容 + mtime + byteCount", () => {
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# Priority\n- Do X\n- Avoid Y\n");
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).not.toBeNull();
    expect(out.priorityStack!.content).toBe("# Priority\n- Do X\n- Avoid Y\n");
    expect(out.priorityStack!.byteCount).toBeGreaterThan(0);
    expect(out.priorityStack!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("STEERING.md 缺失时 priority stack 为 null，并提供 unavailable diagnosis", () => {
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).toBeNull();
    expect(out.unavailableSources.find((s) => s.section === "priorityStack")).toBeDefined();
  });

  it("roadmap rail 提取 checkbox row，并为首个未勾选项提供 railItemCode + isNextUnchecked", () => {
    mkdirSync(join(workspaceRoot, "roadmap"), { recursive: true });
    writeFileSync(join(workspaceRoot, "roadmap", "PROGRESS.md"),
      "# Roadmap\n- [x] PL-005 Phase A\n- [x] PL-019 done\n- [ ] PL-022 next\n- [ ] PL-030 later\n");
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.roadmapRail).not.toBeNull();
    const items = out.roadmapRail!.items;
    expect(items).toHaveLength(4);
    expect(items[0]?.railItemCode).toBe("PL-005");
    expect(items[0]?.done).toBe(true);
    expect(items[2]?.railItemCode).toBe("PL-022");
    expect(items[2]?.isNextUnchecked).toBe(true);
    expect(items[3]?.isNextUnchecked).toBe(false);
    expect(out.roadmapRail!.counts.done).toBe(2);
    expect(out.roadmapRail!.counts.total).toBe(4);
    expect(out.roadmapRail!.counts.nextUncheckedLine).toBe(items[2]?.line);
  });

  it("lane rail 按 mode-N 分组；top-N 优先非 done；next-pull 标记首个非 done、非 blocked 项", () => {
    mkdirSync(join(workspaceRoot, "delivery-ready", "mode-2"), { recursive: true });
    mkdirSync(join(workspaceRoot, "delivery-ready", "mode-3"), { recursive: true });
    writeFileSync(join(workspaceRoot, "delivery-ready", "mode-2", "PROGRESS.md"),
      "# Mode 2\n- [x] alpha done\n- [~] beta blocked\n- [ ] gamma next\n- [ ] delta later\n");
    writeFileSync(join(workspaceRoot, "delivery-ready", "mode-3", "PROGRESS.md"),
      "# Mode 3\n- [x] one done\n- [x] two done\n");
    const composer = new SteeringComposer({ workspaceRoot, topNPerLane: 3 });
    const out = composer.compose();
    expect(out.laneRails).toHaveLength(2);
    const mode2 = out.laneRails.find((l) => l.laneId === "mode-2")!;
    expect(mode2.healthBadges).toEqual({ active: 2, blocked: 1, done: 1, total: 4 });
    expect(mode2.nextPullLine).not.toBeNull();
    const nextPullItem = mode2.topItems.find((i) => i.isNextPull);
    expect(nextPullItem?.text).toBe("gamma next");
    // Top-3 优先非 done——beta（blocked）与 gamma+delta（active）排在 alpha（done）前。
    expect(mode2.topItems.map((i) => i.text)).toEqual(["beta blocked", "gamma next", "delta later"]);
    const mode3 = out.laneRails.find((l) => l.laneId === "mode-3")!;
    expect(mode3.nextPullLine).toBeNull();
  });

  it("per-section override 优先于 workspace-root 默认值", () => {
    const overrideRoot = join(cleanup, "elsewhere");
    mkdirSync(overrideRoot, { recursive: true });
    writeFileSync(join(overrideRoot, "STEERING-CUSTOM.md"), "# overridden steering");
    writeFileSync(join(workspaceRoot, "STEERING.md"), "# default steering");
    const composer = new SteeringComposer({
      workspaceRoot,
      steeringPath: join(overrideRoot, "STEERING-CUSTOM.md"),
    });
    const out = composer.compose();
    expect(out.priorityStack?.content).toBe("# overridden steering");
  });

  it("无 source 的 composer 返回空 payload + 3 条 unavailable diagnosis", () => {
    const composer = new SteeringComposer({ workspaceRoot });
    const out = composer.compose();
    expect(out.priorityStack).toBeNull();
    expect(out.roadmapRail).toBeNull();
    expect(out.laneRails).toEqual([]);
    expect(out.unavailableSources.map((s) => s.section).sort()).toEqual(["laneRails", "priorityStack", "roadmapRail"]);
  });
});
