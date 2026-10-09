// OPR.0.4.6.FAC2 C2——factory-rsi 单 rig RSI 工厂启动器（工件 B）。
//
// 证明 rig spec + 其两个新智能体通过校验，并且——承重交叉检查——每个 `factory-rsi`
// 工作流角色 1:1 钉到本 rig 声明的某个席位（无孤儿角色、无未用席位）。
// 仅 VM：此处编写，深度 preflight/scan 分支在一致租约上运行。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");
const RIG_SPEC = join(SPECS_ROOT, "rigs/launch/factory-rsi/rig.yaml");
const WORKFLOW_SPEC = resolve(
  import.meta.dirname,
  "../src/builtins/workflow-specs/factory-rsi.yaml",
);
const NEW_AGENTS = [
  "agents/factory-rsi/dogfood/agent.yaml",
  "agents/factory-rsi/release-manager/agent.yaml",
];

interface RigMember {
  id: string;
  agent_ref: string;
  runtime: string;
  profile: string;
  cwd: string;
  model?: string;
}
interface RigPod {
  id: string;
  members: RigMember[];
}

function loadRig(): { name: string; pods: RigPod[] } {
  return parseYaml(readFileSync(RIG_SPEC, "utf-8")) as { name: string; pods: RigPod[] };
}

describe("OPR.0.4.6.FAC2 factory-rsi rig 启动器", () => {
  it("对照 rig-spec schema 校验", () => {
    const raw = parseYaml(readFileSync(RIG_SPEC, "utf-8"));
    const result = RigSpecSchema.validate(raw);
    expect(result.errors).toEqual([]);
  });

  it("恰好声明七个 RSI 席位，每个 pod 一个成员", () => {
    const rig = loadRig();
    expect(rig.name).toBe("factory-rsi");
    const seats = rig.pods.map((p) => {
      expect(p.members).toHaveLength(1);
      return `${p.id}-${p.members[0]!.id}`;
    });
    expect(seats.sort()).toEqual(
      [
        "build-implementer",
        "check-qa",
        "dogfood-tester",
        "orch-lead",
        "plan-planner",
        "release-manager",
        "review-reviewer",
      ].sort(),
    );
  });

  it("每个席位的 runtime 遵循 0.4.6 FAC2 设计（builder 跑 claude-code；qa/review/dogfood 跑备用运行时；每个席位继承其 runtime 默认 model）", () => {
    // 漂移判定：陈旧断言（0.4.6 的有意改动），不是回归。此前断言钉住 "Sonnet Claude
    // 席位；Codex builder+checker"，带 model: sonnet。0.4.6 版（提交 8250d702）发布了
    // `specs/rigs/launch/factory-rsi/rig.yaml` + CULTURE.md，其设计刻意不同，逐字记录在
    // rig.yaml summary 中："Seats inherit their runtime's default model; qa, review, and
    // 在 alternate runtime 上 dogfood 运行，以跨 runtime 多样性对抗
    // the builder."（另见 CULTURE.md:34 的 `review-reviewer | codex` 与 :41）。
    // 因此 builder 跑 claude-code，qa/review/dogfood 跑 codex，没有任何席位带 model pin。
    // 本测试现在跟踪的是已发布的 spec。
    const bySeat = new Map<string, RigMember>();
    for (const pod of loadRig().pods) bySeat.set(`${pod.id}-${pod.members[0]!.id}`, pod.members[0]!);

    // builder + planner/release/orch 席位跑 claude-code。
    for (const seat of ["plan-planner", "build-implementer", "release-manager", "orch-lead"]) {
      expect(bySeat.get(seat)!.runtime).toBe("claude-code");
    }
    // qa、review、dogfood 跑在备用运行时（codex）上，
    // 以获得相对 builder 的跨运行时多样性。
    for (const seat of ["check-qa", "review-reviewer", "dogfood-tester"]) {
      expect(bySeat.get(seat)!.runtime).toBe("codex");
    }
    // 每个席位继承其 runtime 的默认 model——无按席位的 model pin。
    for (const seat of bySeat.keys()) {
      expect(bySeat.get(seat)!.model).toBeUndefined();
    }
  });

  it("两个新的 factory-rsi agent 通过校验", () => {
    for (const file of NEW_AGENTS) {
      const raw = parseAgentSpec(readFileSync(join(SPECS_ROOT, file), "utf-8"));
      const result = validateAgentSpec(raw);
      expect(result.valid).toBe(true);
    }
  });

  it("每个 factory-rsi 工作流角色 1:1 钉到某个 factory-rsi 席位（无孤儿角色、无未用席位）", () => {
    const rig = loadRig();
    const seatRefs = new Set(rig.pods.map((p) => `${p.id}-${p.members[0]!.id}@factory-rsi`));

    const spec = parseWorkflowSpec(readFileSync(WORKFLOW_SPEC, "utf-8"), WORKFLOW_SPEC);
    const roleTargets = Object.values(spec.roles).map((r) => r.preferred_targets?.[0]);

    // 每个角色解析到一个已声明的席位。
    for (const target of roleTargets) {
      expect(target).toBeDefined();
      expect(seatRefs.has(target!)).toBe(true);
    }
    // 映射是双射：7 个角色 ↔ 7 个席位，每个席位恰好一次。
    expect(new Set(roleTargets).size).toBe(seatRefs.size);
    expect(roleTargets.length).toBe(seatRefs.size);
  });
});
