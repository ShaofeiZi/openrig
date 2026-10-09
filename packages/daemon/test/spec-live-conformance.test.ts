// Build B——让 spec-vs-live topology 漂移可见。RED-first。
//
// 存在原因：runtime 修改后没有任何内容回写 rig spec。`rig expand` 通过后台服务向运行中的 rig 添加
// pod，但从不触碰 rigRoot spec，因此漂移不是意外，而是已发布动作的必然结果。所有重建 rig 的组件
// 仍把 spec 视为权威，`bundle-assembler` 也从不查询实时 DB，直接把它逐字复制进 bundle。在此主机上，
// 这意味着运行 14 个席位时，bundle export 会静默产生 8 席位 rig，因为 spec 内部一致且验证干净。
//
// 此模块不修复漂移，而是在漂移造成损害的两个时刻让它可被表达。
//
// 最重要的不变量：当且仅当 `conforms` 为 false 时，`message` 非 null。无法保持安静的检查和无法触发
// 的检查一样无用；每次 export 都告警会训练读者略过，然后真正的一次看起来与此前 96 次相同。

import { describe, it, expect } from "vitest";
import {
  compareSpecToLive,
  topologyFromRigSpec,
  topologyFromLiveLogicalIds,
  type Topology,
} from "../src/domain/spec-live-conformance.js";

/** 此 host 的实际结构：spec 声明 orch/dev/review，实时状态还运行 dev50/review50。 */
const SPEC_3_8: Topology = {
  pods: ["orch", "dev", "review"],
  seats: ["orch.lead", "orch.advisor", "dev.planner", "dev.guard", "dev.driver", "dev.qa", "review.r1", "review.r2"],
};
const LIVE_5_14: Topology = {
  pods: ["orch", "dev", "review", "dev50", "review50"],
  seats: [
    ...SPEC_3_8.seats,
    "dev50.planner", "dev50.guard", "dev50.driver", "dev50.qa",
    "review50.r1", "review50.r2",
  ],
};

describe("spec-vs-live 一致性", () => {
  it("负对照——无漂移的 rig 符合要求且不输出任何内容", () => {
    const r = compareSpecToLive(SPEC_3_8, { ...SPEC_3_8 });
    expect(r.conforms).toBe(true);
    expect(r.message).toBeNull();
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.seatsMissingFromSpec).toEqual([]);
  });

  it("顺序和重复项不会制造漂移", () => {
    const shuffled: Topology = {
      pods: ["review", "orch", "dev", "orch"],
      seats: [...SPEC_3_8.seats].reverse().concat("dev.qa"),
    };
    expect(compareSpecToLive(SPEC_3_8, shuffled).conforms).toBe(true);
  });

  it("此 host 的真实漂移——点名 spec 中缺失的 pod，并给出两边计数", () => {
    const r = compareSpecToLive(SPEC_3_8, LIVE_5_14);
    expect(r.conforms).toBe(false);
    expect(r.spec).toEqual({ pods: 3, seats: 8 });
    expect(r.live).toEqual({ pods: 5, seats: 14 });
    expect(r.podsMissingFromSpec).toEqual(["dev50", "review50"]);
    expect(r.seatsMissingFromSpec).toHaveLength(6);
    expect(r.podsMissingFromLive).toEqual([]);
  });

  it("消息点明实际差异，而非泛泛提醒", () => {
    const m = compareSpecToLive(SPEC_3_8, LIVE_5_14).message!;
    // 读者必须仅凭这一行就能采取行动。
    expect(m).toContain("3 pods");
    expect(m).toContain("8 seats");
    expect(m).toContain("5");
    expect(m).toContain("14");
    expect(m).toContain("dev50");
    expect(m).toContain("review50");
  });

  it("反方向漂移——spec 中存在但未运行的 pod", () => {
    const live: Topology = {
      pods: ["orch", "dev"],
      seats: SPEC_3_8.seats.filter((s) => !s.startsWith("review.")),
    };
    const r = compareSpecToLive(SPEC_3_8, live);
    expect(r.conforms).toBe(false);
    expect(r.podsMissingFromLive).toEqual(["review"]);
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.message).toContain("review");
  });

  it("双方都声明的 pod 内存在席位级漂移", () => {
    const live: Topology = { pods: SPEC_3_8.pods, seats: [...SPEC_3_8.seats, "dev.second-driver"] };
    const r = compareSpecToLive(SPEC_3_8, live);
    expect(r.conforms).toBe(false);
    expect(r.podsMissingFromSpec).toEqual([]);
    expect(r.seatsMissingFromSpec).toEqual(["dev.second-driver"]);
  });

  it("当且仅当 conforms 为 false 时 message 非 null", () => {
    const cases: Array<[Topology, Topology]> = [
      [SPEC_3_8, SPEC_3_8],
      [SPEC_3_8, LIVE_5_14],
      [{ pods: [], seats: [] }, { pods: [], seats: [] }],
      [{ pods: [], seats: [] }, SPEC_3_8],
    ];
    for (const [spec, live] of cases) {
      const r = compareSpecToLive(spec, live);
      expect(r.message === null).toBe(r.conforms);
    }
  });

  it("空 live topology 不会被报告为符合且无漂移的静默状态", () => {
    // 后台服务未返回节点时不得读作“spec 匹配”。live 侧静默意味着缺少证据，检查必须明确说明，
    // 而不是通过。
    const r = compareSpecToLive(SPEC_3_8, { pods: [], seats: [] });
    expect(r.conforms).toBe(false);
    // 使用排序而非声明顺序；与阻止顺序制造漂移的归一化一致。
    expect(r.podsMissingFromLive).toEqual(["dev", "orch", "review"]);
  });
});

describe("topology 提取", () => {
  it("从解析后的 RigSpec 读取 pod 和 seat", () => {
    const spec = {
      pods: [
        { id: "orch", members: [{ id: "lead" }, { id: "advisor" }] },
        { id: "dev", members: [{ id: "driver" }] },
      ],
    };
    expect(topologyFromRigSpec(spec as never)).toEqual({
      pods: ["orch", "dev"],
      seats: ["orch.lead", "orch.advisor", "dev.driver"],
    });
  });

  it("从 node logicalId 派生 live topology，并忽略格式错误的 id", () => {
    const t = topologyFromLiveLogicalIds([
      "orch.lead", "orch.advisor", "dev50.driver", "", null as never, "no-dot",
    ]);
    expect(t.pods).toEqual(["orch", "dev50"]);
    expect(t.seats).toEqual(["orch.lead", "orch.advisor", "dev50.driver"]);
  });
});
