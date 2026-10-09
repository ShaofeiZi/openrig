import { describe, it, expect } from "vitest";
import { resolveExternal, OPERATOR_HUMAN_DEFAULT_SLOT, type RegisteredEntity } from "../src/domain/gateway/external-admission.js";
import { isHumanSeatSessionRef } from "../src/domain/session-name.js";

// M1 A4b——@external 实体准入解析器。契约 2a57d099。这里覆盖四种裁决结果；
// proof-2 的实体级教学拒绝文案位于此处（领域级回退是 A1/A2 的
// unknown_destination_rig 兜底）。

const REG: RegisteredEntity[] = [
  { entityId: "mike", address: "mike@external" },
  { entityId: "founder", address: "founder@external" },
];

describe("A4b resolveExternal", () => {
  it("已登记的 mike@external 解析为 { registered }", () => {
    const r = resolveExternal("mike", REG);
    expect(r.kind).toBe("registered");
    if (r.kind === "registered") expect(r.entityId).toBe("mike");
  });

  it("字面 scheme slack:U012AB3CD 解析为一次性 { scheme } 地址（绝不查询 registry）", () => {
    const r = resolveExternal("slack:U012AB3CD", REG);
    expect(r.kind).toBe("scheme");
    if (r.kind === "scheme") { expect(r.scheme).toBe("slack"); expect(r.handle).toBe("U012AB3CD"); }
  });

  it("未登记的 stranger@external 会以教学信息响亮拒绝，绝不降级为 agent 类", () => {
    const r = resolveExternal("stranger", REG);
    expect(r.kind).toBe("unregistered");
    if (r.kind === "unregistered") {
      expect(r.error).toMatch(/not.*registered|no registered/i);
      expect(r.error).toMatch(/rig gateway human add/);            // teaching: how to fix
      expect(r.error).toMatch(/NOT downgraded to an agent seat/i); // never a silent agent-class fall
    }
  });

  it("scheme 形式不通过 registry 解析（看似已登记的 scheme 仍保持 scheme）", () => {
    const r = resolveExternal("mike:extra", REG);
    expect(r.kind).toBe("scheme");
  });

  it("默认 HUMAN 操作人员席位为 human-operator@kernel（前缀约定）", () => {
    expect(OPERATOR_HUMAN_DEFAULT_SLOT).toBe("human-operator@kernel");
  });

  // 持久类别守卫（dev-planner 裁决）：以 HUMAN 命名的席位必须归类为 human。
  // 易错的 `-human` 后缀形式（operator-human@kernel）不匹配任何 human-seat 谓词；
  // 在此固定前缀约定，防止未来重命名破坏约定。
  it("默认 HUMAN 席位满足 isHumanSeatSessionRef（按 human 类识别，而非易错的 -human 后缀）", () => {
    expect(isHumanSeatSessionRef(OPERATOR_HUMAN_DEFAULT_SLOT)).toBe(true);
    // 有缺陷的旧形式不会匹配，以此证明守卫有区分能力。
    expect(isHumanSeatSessionRef("operator-human@kernel")).toBe(false);
  });
});
