// §6 RECONCILIATION——警告发出顺序固定项（PM 裁定 2026-08-05，fold-wave qitem 79159e6f）。
// 当一次 preflight 同时发出两类已证实警告——main 的 managed-activity-hook DELIVERY 警告
//（已折入 0.5.0 的内容）和传入的 permission-policy DISCOVERY 警告（重新堆叠的 4.8 链）——
// 发出顺序为 ACTIVITY-HOOK-FIRST、POLICY-APPENDED。
//
// 理由（PM）：折入顺序等于发出顺序——main 是 restack 的固定基础，其已折入的 activity-hook 内容
// 是底层（先发出）；传入的重叠 policy 内容随后追加，符合 rebase 的机械粒度和 gate-first 纪律，并在
// restack 下保持 0.5.0 现有警告内容逐字节稳定（真正的稳定性不变量；这不涉及 npm 兼容性——npm
// 携带从 0.4.7 切出的 POLICY 链，而 activity-hook 是尚未发布的本地 0.5.0 工作，因此此次合并前
// 两种顺序均未在任何地方发布；此固定项锁定合并后的顺序）。
//
// 语义边界：此顺序仅用于展示。任何把首条警告视为更高优先级的消费者都属于缺陷，而不是排序输入；
// 此固定项只冻结展示，绝不冻结语义。
import { describe, expect, it } from "vitest";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";

// 此 agent.yaml 声明并选择 claude_activity_hooks runtime resource，因此 claude-code 成员会触发
// managed-activity-hook 投递检查（资产缺失时发出警告）。
const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
  runtime_resources:
    - id: claude-activity-hooks
      path: runtime/claude-activity-hooks.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      skills: []
      runtime_resources: [claude-activity-hooks]`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (p) => p.includes("agents/impl"),
    readFile: (p) => {
      if (p.includes("agents/impl")) return AGENT_YAML;
      throw new Error(`not found: ${p}`);
    },
  };
}

const RIG_YAML = `version: "0.2"
name: order-pin
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        cwd: .
    edges: []
`;

describe("§6 reconciliation——警告发出顺序（activity-hook-first、policy-appended）", () => {
  it("preflight 同时发出 activity-hook 投递警告和 policy 发现警告时前者在先、后者追加", async () => {
    const result = await rigPreflight({
      rigSpecYaml: RIG_YAML,
      rigRoot: "/probe/root",
      fsOps: fsOps(),
      // 资产缺失会触发 managed-activity-hook 投递警告（非致命，READY 路径）。
      claudeActivityAssets: { relayPath: "/missing/relay.cjs", manifestPath: "/missing/claude.json" },
    });
    expect(result.ready).toBe(true); // 两条警告都非致命，rig up 保持 rc0。

    const hookIdx = result.warnings.findIndex((w) =>
      w.includes("无法交付受管 Claude 活动 hook"),
    );
    const policyIdx = result.warnings.findIndex((w) => w.includes("permission_policy"));

    expect(hookIdx).toBeGreaterThanOrEqual(0); // 存在 main 的 activity-hook 投递警告。
    expect(policyIdx).toBeGreaterThanOrEqual(0); // 存在 4.8 permission-policy 发现警告。
    // 顺序固定项：activity-hook-first、policy-appended（PM 裁定）。任一方向的漂移都必须是有意重定规则，
    // 不能是意外；按照语义边界，它只改变展示。
    expect(hookIdx).toBeLessThan(policyIdx);
  });
});
