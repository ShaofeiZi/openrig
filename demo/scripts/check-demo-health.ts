import {
  getCurrentRigSummary,
  listRigNodes,
  parseArgs,
  isAgentRuntime,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rig = String(args["rig"] ?? args["rig-id"] ?? "demo-rig");
  const json = args["json"] === true;

  const rigSummary = getCurrentRigSummary(rig);
  const nodes = listRigNodes(rig);

  const summary = {
    rig,
    rigId: rigSummary?.rigId ?? null,
    status: rigSummary?.status ?? null,
    exists: Boolean(rigSummary),
    nodeCount: nodes.length,
    agentCount: nodes.filter((node) => isAgentRuntime(node.runtime)).length,
    startupReady: nodes.filter((node) => node.startupStatus === "ready").map((node) => node.logicalId),
    startupPending: nodes.filter((node) => node.startupStatus !== "ready").map((node) => ({
      logicalId: node.logicalId,
      startupStatus: node.startupStatus,
      restoreOutcome: node.restoreOutcome,
      latestError: node.latestError ?? null,
    })),
    resumeMetadata: nodes
      .filter((node) => isAgentRuntime(node.runtime))
      .map((node) => ({
        logicalId: node.logicalId,
        runtime: node.runtime,
        resumeType: node.resumeType ?? null,
        hasResumeToken: Boolean(node.resumeToken),
      })),
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`演示工作组健康状态：${rig}`);
    if (summary.rigId) {
      console.log(`- rigId: ${summary.rigId}`);
    }
    if (summary.status) {
      console.log(`- status: ${summary.status}`);
    }
    console.log(`- 是否存在：${summary.exists ? "是" : "否"}`);
    console.log(`- 节点数：${summary.nodeCount}`);
    console.log(`- 已就绪：${summary.startupReady.length}`);
    if (summary.startupPending.length > 0) {
      console.log("- 待处理/失败：");
      for (const item of summary.startupPending) {
        console.log(
          `  ${item.logicalId}: startup=${item.startupStatus ?? "n/a"} restore=${item.restoreOutcome ?? "n/a"}`
        );
        if (item.latestError) {
          console.log(`    错误：${item.latestError}`);
        }
      }
    }
    console.log("- 恢复元数据：");
    for (const item of summary.resumeMetadata) {
      console.log(
        `  ${item.logicalId} [${item.runtime}] 类型=${item.resumeType ?? "none"} token=${item.hasResumeToken ? "有" : "无"}`
      );
    }
  }

  if (!summary.exists || summary.nodeCount === 0) {
    process.exitCode = 1;
  }
}

await main();
