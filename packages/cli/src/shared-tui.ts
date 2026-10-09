import { spawn } from "node:child_process";
import { DaemonClient } from "./client.js";

interface SharedTuiClient {
  readonly baseUrl?: string;
  get<T>(path: string): Promise<{ status: number; data: T }>;
}

/** 在所选实例上解析终端，而不是记住某个 tmux 名称。 */
export async function sharedTuiTarget(client: SharedTuiClient = new DaemonClient()): Promise<string> {
  if (client.baseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
    throw new Error("共享挂接使用本地 tmux。请在所选后台服务所在机器上运行 zrig tui --shared；独立的 zrig tui 才能使用这条远程连接。");
  }
  const rigs = await client.get<Array<{ rigId: string; rigName?: string; name?: string }>>("/api/ps");
  if (rigs.status >= 400) throw new Error(`无法读取工作组列表（HTTP ${rigs.status}）；请运行 zrig status。`);
  const kernels = rigs.data.filter((r) => (r.rigName ?? r.name) === "kernel");
  if (kernels.length > 1) throw new Error("已登记多个内核。请用 zrig ps 检查，并在共享挂接前理清应绑定哪一个。");
  const kernel = kernels[0];
  if (!kernel) throw new Error("本实例上未登记任何内核。请运行 zrig status；在启动后台服务前先完成运行时认证。独立使用：zrig tui。");
  const nodes = await client.get<Array<{
    logicalId: string; runtime: string | null;
    canonicalSessionName: string | null; tmuxAttachCommand: string | null;
  }>>(`/api/rigs/${encodeURIComponent(kernel.rigId)}/nodes`);
  if (nodes.status >= 400) throw new Error(`无法读取内核终端（HTTP ${nodes.status}）；请运行 zrig status。`);
  const terminal = nodes.data.find((n) => n.logicalId === "operator.human" && n.runtime === "terminal");
  if (!terminal?.canonicalSessionName || !terminal.tmuxAttachCommand) {
    throw new Error("内核尚未绑定共享终端。请用 zrig ps --nodes --rig kernel 检查；应恢复既有终端，而不是再启动一个内核。独立使用：zrig tui。");
  }
  return terminal.canonicalSessionName;
}

export async function attachSharedTui(target: string): Promise<number> {
  // 即使在 tmux 内部也挂接一个新客户端。从智能体的子 shell 里调用
  // switch-client 会把别人的客户端切走。
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    const child = spawn("tmux", ["attach-session", "-t", `=${target}`], { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
