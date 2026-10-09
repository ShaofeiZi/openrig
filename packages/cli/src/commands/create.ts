import { resolve as resolvePath } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveDefaultAgentRef } from "./topology-default-agent.js";

interface CreateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{
    logicalId: string;
    status: "launched" | "failed" | "attention_required";
    sessionName?: string;
    error?: string;
  }>;
  errors?: string[];
  message?: string;
  error?: string;
}

export function createCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("create").description("无需编写规范即可创建单席位工作组");
  const getDeps = () => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<name>", "新工作组的名称")
    .option("--runtime <runtime>", "智能体运行时", "claude-code")
    .option("--cwd <path>", "席位的工作目录", process.cwd())
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (name: string, opts: { runtime: string; cwd: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      let agentRef: string;
      try {
        agentRef = await resolveDefaultAgentRef(client);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const cwd = resolvePath(opts.cwd);
      const logicalId = "main.lead";
      const yaml = stringifyYaml({
        version: "0.2",
        name,
        pods: [{
          id: "main",
          label: "Main",
          members: [{
            id: "lead",
            agent_ref: agentRef,
            runtime: opts.runtime,
            profile: "default",
            cwd,
          }],
          edges: [],
        }],
        edges: [],
      });

      const res = await client.postText<CreateResult>(
        "/api/rigs/import",
        yaml,
        "text/yaml",
        { "X-Rig-Root": cwd, "X-Cwd-Override": cwd },
        { timeoutMs: 120_000 },
      );
      const node = res.data.nodes?.find((candidate) => candidate.logicalId === logicalId);
      const ok = res.status < 400 && node?.status === "launched";

      if (opts.json) {
        console.log(JSON.stringify({
          ok,
          rigId: res.data.rigId,
          rigName: name,
          pod: "main",
          seat: logicalId,
          source: agentRef,
          node,
        }, null, 2));
      } else if (ok) {
        console.log(`已创建工作组 ${name}（${res.data.rigId}）`);
        console.log(`  席位：${logicalId}${node?.sessionName ? `（${node.sessionName}）` : ""}`);
      } else {
        const detail = res.data.errors?.join("；")
          ?? res.data.message
          ?? res.data.error
          ?? node?.error
          ?? `创建失败（HTTP ${res.status}）`;
        console.error(detail);
      }

      if (!ok) process.exitCode = 1;
    });

  return cmd;
}
