import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// GHOST-STAGE (i-c) 接线锚点。除非启动流程注入真实的存活代数解析器,否则 WatchdogPolicyEngine 中
// 触发时的目标代数闸门是失效的(INERT)——缺少 resolveTargetGeneration 时闸门不生效(no-op),
// 与代数绑定的唤醒会打到后继席位(即 dead-invalidator 这一类问题)。该引擎在启动流程深处构造
//(无法在单测中直接构造),因此这里在源码层面固定这条启用路径:接线代码一旦缺失就会在此处失败,
// 从而避免带着一个被静默关闭的闸门发布。
describe("(i-c) 接线锚点 —— 启动流程向看守器注入真实的目标代数解析器", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/startup.ts", import.meta.url)),
    "utf-8",
  );

  it("将 resolveTargetGeneration 传给 WatchdogPolicyEngine,并接到实时的占位代数查询上", () => {
    expect(src).toMatch(/resolveTargetGeneration:\s*\(s\)\s*=>\s*sessionRegistry\.currentOccupantGenerationForSession\(s\)/);
  });

  it("将队列的终态计时器解析器传给投递前接缝", () => {
    expect(src).toMatch(
      /resolvePreDeliveryTerminalReason:\s*\(\{ jobId \}\)\s*=>\s*queueRepoInstance\.resolveWatchdogPreDeliveryTerminalReason\(jobId\)/,
    );
  });
});
