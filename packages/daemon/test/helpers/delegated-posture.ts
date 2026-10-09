import type { OperatingPosture } from "../../src/domain/rig-mode/operating-posture.js";

/** 现有诊断机制测试会刻意模拟 delegated 工作。Scope 解析及 default/unknown 控制使用
 * operating-posture.test.ts 中的真实 reader。 */
export function delegatedPostureFixture(): OperatingPosture {
  return { posture: "delegated", source: "binding", context: { rigId: "fixture", phase: { value: "planning", source: "fixture" }, sources: ["fixture"] },
    binding: { id: "rig:fixture", scope: "rig", setAt: "2026-09-05T00:00:00Z", evidence: "explicit isolated unit fixture" },
    reason: "显式 delegated 测试 fixture", grantsAuthority: false };
}
