import { dirname } from "node:path";
import type { DaemonClient } from "../client.js";

interface AgentLibraryEntry {
  kind: "agent";
  name: string;
  sourceType: string;
  sourcePath: string;
}

/** 解析随后台服务一同发布、已安装的通用智能体。 */
export async function resolveDefaultAgentRef(client: DaemonClient): Promise<string> {
  const res = await client.get<AgentLibraryEntry[]>("/api/specs/library?kind=agent");
  const entry = res.data?.find(
    (candidate) =>
      candidate.kind === "agent"
      && candidate.name === "orchestrator"
      && candidate.sourceType === "builtin",
  );
  if (!entry) {
    throw new Error("随附的默认智能体不可用。请重新安装 zrig 后重试。");
  }
  return `path:${dirname(entry.sourcePath)}`;
}
