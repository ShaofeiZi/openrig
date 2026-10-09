import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

// 该触发分两个阶段（prep → 等待空闲 → /compact）；等待空闲阶段最长可达后台服务的
// 手动准备上限（约 120 秒）。因此为 HTTP 调用预留充裕的超时余量，避免客户端在流程
// 中途超时。
const MANUAL_COMPACT_REQUEST_TIMEOUT_MS = 180_000;

export interface CompactDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

/**
 * OPR.0.4.3.14 — `zrig compact <session>`：按需为单个 Claude 席位手动执行
 * 引导式压缩生命周期（prep → /compact → restore → audit），不受自动阈值约束。
 * 与只读的 `zrig compact-plan` 分诊命令不同。
 */
export function compactCommand(depsOverride?: CompactDeps): Command {
  const cmd = new Command("compact")
    .description("为单个 Claude 席位手动执行引导式压缩流程（prep → /compact → restore → audit）")
    .argument("<session>", "目标 Claude 会话名（例如 dev-impl@my-rig）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig compact dev-impl@my-rig          立即手动压缩一个 Claude 席位
  zrig compact dev-impl@my-rig --json   供智能体使用的 JSON 输出

按需为单个 Claude 席位执行与自动压缩策略相同的引导式生命周期（压缩前准备 →
带信任桥接的 /compact → 从标记恢复 → 读取深度审计），无需等待上下文阈值。
它不是裸 /compact，也不是只读的 zrig compact-plan 分诊命令。非 Claude 席位
会被拒绝。/compact 仅在准备轮次完成后才发送。`);

  const getDepsF = (): CompactDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (session: string, opts: { json?: boolean }) => {
    const deps = getDepsF();

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("后台服务未运行。启动命令：zrig daemon start");
      process.exitCode = 1;
      return;
    }

    const client = deps.clientFactory(getDaemonUrl(status));
    const res = await client.post<Record<string, unknown>>(
      "/api/compaction/trigger",
      { session },
      { headers: terminalAuthHeaders(), timeoutMs: MANUAL_COMPACT_REQUEST_TIMEOUT_MS },
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    if (res.status >= 400) {
      const error = res.data["error"] as string | undefined;
      console.error(error ?? `手动压缩失败（HTTP ${res.status}）`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    const stage = res.data["stage"] as string | undefined;
    console.log(`已为 ${session} 触发手动压缩${stage ? `（阶段：${stage}）` : ""}。`);
    console.log("当该席位占用回落到阈值以下时，恢复与读取深度审计提示会自动继续。");
  });

  return cmd;
}
