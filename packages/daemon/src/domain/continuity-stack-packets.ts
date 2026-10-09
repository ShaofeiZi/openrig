export interface ContinuitySeatIdentity {
  sessionName: string;
  successorSessionName: string;
  predecessorResumeHandle: string;
  mechanicDestination: string;
}

export const RUNG_1_STACK_STEPS = [
  "create-staged-unbound-successor",
  "freshness-check",
  "model-divergence-gate",
  "world-install",
  "mission-install",
  "position-grant",
  "introduce-yourself",
] as const;

export function rung1StackSteps(): string[] {
  return [...RUNG_1_STACK_STEPS];
}

export function renderRung1Packet(seat: ContinuitySeatIdentity): string {
  return [
    "# 连续性阶梯 1——准备已暂存的继任者",
    "",
    "创建一个全新、已暂存且尚未绑定的继任者。安装任何内容前，先证明其身份为空且模型符合固定要求；复用的对话或回退模型会让后续每份回执都指向错误的 occupant。",
    "",
    `继任候选：${seat.successorSessionName}`,
    "首次阅读的角色：`orienting-to-an-inherited-seat`。把这个指针保留在持久 packet 中，因为按席位名称定位的 runtime prompt 可能比 occupant 存续更久，继而变成幽灵指令。",
    "然后依次安装 world、mission 和 position。继任者自行推导第 5 层 delta，再由第二位读者复核；读过 deposits 并不能证明它们已安装。",
    "以对话方式开始学徒期。在记录 owner 的明确指令之前，继任者不具备任何权限。",
  ].join("\n");
}

export function renderRung1IncumbentNotice(seat: ContinuitySeatIdentity): string {
  return [
    `${seat.sessionName} 已越过连续性准备阈值。`,
    "打开 `retiring-and-inheriting-a-seat` 的 apprentice-mode 章节，然后执行随附的 `continuity/apprentice-prepare.md` stack。",
    "准备继任者时保留咨询性工作：越接近交接边界，现任 occupant 积累的上下文越有价值。",
  ].join(" ");
}

export interface Rung2Baton {
  destination: string;
  template: string;
  custodyTable: Array<{ duty: string; holder: string; effectReceipt: string }>;
}

export function renderRung2Baton(seat: ContinuitySeatIdentity): Rung2Baton {
  return {
    destination: seat.mechanicDestination,
    template: [
      "已归属的切换接力棒——执行随附的 `continuity/apprentice-cutover.md` stack 及其可移植切换 SOP；仅仅知情不等于承担 custody。",
      "投递回执：staged/submitted/consumed。",
      "执行者租约：one-active-walker。",
      "权限：authority-effective-at-effect-receipt；意图时刻的声明不算数。",
      "切换前列出 deposits 和长期职责。不要自动重新绑定；mechanic 只根据 owner 的明确指令行动。",
    ].join("\n"),
    custodyTable: [],
  };
}

export function validateCustodyRecord(record: {
  claimedAt: "intent" | "effect";
  effectReceipt: string | null;
}): { ok: true } {
  if (record.claimedAt !== "effect" || !record.effectReceipt?.trim()) {
    throw new Error("custody 需要持久的生效回执；意图时刻声明的归属并不是已生效的 custody");
  }
  return { ok: true };
}

export function checkStandingDutyCustody(input: {
  deposits: string[];
  custodyTable: string[];
}): { missing: string[] } {
  const held = new Set(input.custodyTable);
  return { missing: input.deposits.filter((duty) => !held.has(duty)) };
}

export interface GateReceipt {
  gate: string;
  evidence: string;
  worder: string;
}

export function validateGateModel(input: {
  receipts: GateReceipt[];
  simplerModel: string | null;
}): { ok: true; model: "receipts" | "declared-simpler" } {
  if (input.simplerModel?.trim()) return { ok: true, model: "declared-simpler" };
  const byGate = new Map(input.receipts.map((receipt) => [receipt.gate, receipt]));
  for (const gate of ["G0", "G1", "G2", "G3"]) {
    const receipt = byGate.get(gate);
    if (!receipt?.evidence.trim() || !receipt.worder.trim()) {
      throw new Error(`缺少持久的 ${gate} 回执；如果此次继任不使用 G0–G3，请声明更简化的模型`);
    }
  }
  return { ok: true, model: "receipts" };
}

export function renderPostCutoverPacket(seat: ContinuitySeatIdentity): string {
  return [
    "只要前任 session 记录仍存在，回访能力就不会过期。",
    `原样 resume handle：claude -p --resume ${seat.predecessorResumeHandle}`,
    "预先拟定的问题：哪个决策仍依赖隐性上下文？出现哪种失败征兆时，继任者应该质疑当前形态？",
    "向仍在线的前任追问原因，从持久 artifact 中查明事实。把每个回答都视为证词。",
  ].join("\n");
}

export function readyCheck(input: {
  expectedModel: string;
  liveModel: string;
  sessionName: string;
}): { ok: boolean; reason: string | null } {
  if (input.liveModel !== input.expectedModel) {
    return { ok: false, reason: "model_divergence" };
  }
  const local = input.sessionName.split("@")[0] ?? input.sessionName;
  if (/(?:-v\d+|-staged|-staging)$/.test(local)) {
    return { ok: false, reason: "noncanonical_successor_name" };
  }
  return { ok: true, reason: null };
}

export interface WidthRecoveryReceipt {
  postRestoreUsedPercentage: number;
  postRestoreUsableWidthPercentage: number;
  saturationBoundPercentage: number;
  widthRecovered: boolean;
  reason: "usable_width_recovered" | "restore_replayed_past_saturation_bound";
}

export function buildWidthRecoveryReceipt(input: {
  usedPercentage: number;
  maximumUsablePercentage: number;
}): WidthRecoveryReceipt {
  const used = Math.max(0, Math.min(100, input.usedPercentage));
  const bound = Math.max(0, Math.min(100, input.maximumUsablePercentage));
  const widthRecovered = used <= bound;
  return {
    postRestoreUsedPercentage: used,
    postRestoreUsableWidthPercentage: 100 - used,
    saturationBoundPercentage: bound,
    widthRecovered,
    reason: widthRecovered
      ? "usable_width_recovered"
      : "restore_replayed_past_saturation_bound",
  };
}
