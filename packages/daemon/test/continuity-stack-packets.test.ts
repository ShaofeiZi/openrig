import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWidthRecoveryReceipt,
  checkStandingDutyCustody,
  readyCheck,
  renderPostCutoverPacket,
  renderRung1IncumbentNotice,
  renderRung1Packet,
  renderRung2Baton,
  rung1StackSteps,
  validateCustodyRecord,
  validateGateModel,
} from "../src/domain/continuity-stack-packets.js";

const seat = {
  sessionName: "advice-lead@rig",
  successorSessionName: "advice-successor-staged@rig",
  predecessorResumeHandle: "123e4567-e89b-12d3-a456-426614174000",
  mechanicDestination: "ops-mechanic@rig",
};

describe("连续性触发命令 stack（S20 P4/P5）", () => {
  it("在锁定的连续性资源目录中随附两套触发命令 stack", () => {
    const root = resolve(import.meta.dirname, "../assets/continuity");
    const prepare = resolve(root, "apprentice-prepare.md");
    const cutover = resolve(root, "apprentice-cutover.md");

    expect(existsSync(prepare)).toBe(true);
    expect(existsSync(cutover)).toBe(true);
    expect(readFileSync(prepare, "utf8")).toMatch(/fresh.*model.*world.*mission.*position.*introduce/is);
    expect(readFileSync(cutover, "utf8")).toMatch(/owned baton.*never auto-rebind/is);
  });

  it("在阶梯 1 artifact 中携带角色指引，并在安装前拦截模型分歧", () => {
    expect(renderRung1Packet(seat)).toContain("orienting-to-an-inherited-seat");
    expect(renderRung1IncumbentNotice(seat)).toContain("retiring-and-inheriting-a-seat");
    expect(renderRung1Packet(seat)).not.toMatch(/advice-lead@rig.*runtime prompt/i);

    const steps = rung1StackSteps();
    expect(steps.indexOf("model-divergence-gate")).toBeLessThan(steps.indexOf("world-install"));
    expect(steps.indexOf("world-install")).toBeLessThan(steps.indexOf("mission-install"));
    expect(steps).toEqual(expect.arrayContaining(["position-grant", "introduce-yourself"]));
  });

  it("渲染已归属、不重新绑定且在生效时刻接管 custody 的阶梯 2 mechanic 接力棒", () => {
    const baton = renderRung2Baton(seat);
    expect(baton.destination).toBe("ops-mechanic@rig");
    expect(baton.template).toContain("staged/submitted/consumed");
    expect(baton.template).toContain("one-active-walker");
    expect(baton.template).toContain("authority-effective-at-effect-receipt");
    expect(baton.template).toContain("切换 SOP");
    expect(baton.custodyTable).toBeDefined();
    expect(baton).not.toHaveProperty("rebindCall");
  });

  it("缺少生效回执、职责或已声明 gate 模型时失败", () => {
    expect(() => validateCustodyRecord({ claimedAt: "intent", effectReceipt: null })).toThrow(/生效回执/);
    expect(checkStandingDutyCustody({ deposits: ["SD1", "SD2"], custodyTable: ["SD1"] }).missing).toEqual(["SD2"]);
    expect(() => validateGateModel({ receipts: [], simplerModel: null })).toThrow(/回执|简化的模型/);
    expect(validateGateModel({
      receipts: ["G0", "G1", "G2", "G3"].map((gate) => ({ gate, evidence: `proof-${gate}`, worder: "owner@rig" })),
      simplerModel: null,
    }).ok).toBe(true);
  });

  it("让回访能力持续有效，并拒绝模型分歧或暂存状态的 READY 身份", () => {
    const packet = renderPostCutoverPacket(seat);
    expect(packet).toMatch(/不会过期/);
    expect(packet).toContain("claude -p --resume 123e4567-e89b-12d3-a456-426614174000");
    expect(packet).toMatch(/预先拟定的问题/);
    expect(packet).not.toMatch(/transcript only|only a transcript/i);

    expect(readyCheck({ expectedModel: "claude-opus-4-1", liveModel: "wrong", sessionName: "advice-lead@rig" }).ok).toBe(false);
    expect(readyCheck({ expectedModel: "claude-opus-4-1", liveModel: "claude-opus-4-1", sessionName: "advice-lead-v2@rig" }).ok).toBe(false);
    expect(readyCheck({ expectedModel: "claude-opus-4-1", liveModel: "claude-opus-4-1", sessionName: "advice-successor-staged@rig" }).ok).toBe(false);
  });

  it("记录恢复后的可用宽度，并如实标记回放至 93% 的样本", () => {
    expect(buildWidthRecoveryReceipt({ usedPercentage: 93, maximumUsablePercentage: 85 })).toMatchObject({
      postRestoreUsedPercentage: 93,
      postRestoreUsableWidthPercentage: 7,
      widthRecovered: false,
      reason: "restore_replayed_past_saturation_bound",
    });
    expect(buildWidthRecoveryReceipt({ usedPercentage: 20, maximumUsablePercentage: 85 })).toMatchObject({
      postRestoreUsableWidthPercentage: 80,
      widthRecovered: true,
    });
  });
});
