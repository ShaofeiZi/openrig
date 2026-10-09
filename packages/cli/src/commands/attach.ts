import { Command } from "commander";
import { execSync } from "node:child_process";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type TmuxExecFn = (cmd: string) => string;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const defaultTmuxExec: TmuxExecFn = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

export function resolveAttachContext(tmuxExec: TmuxExecFn = defaultTmuxExec):
  | { attachmentType: "external_cli" }
  | { attachmentType: "tmux"; tmuxSession: string; tmuxWindow?: string; tmuxPane: string } {
  const tmuxPane = process.env["TMUX_PANE"];
  if (!tmuxPane) {
    return { attachmentType: "external_cli" };
  }

  try {
    const output = tmuxExec(`tmux display-message -p -t ${JSON.stringify(tmuxPane)} "#{session_name}\n#{window_id}\n#{pane_id}"`);
    const [tmuxSession, tmuxWindow, resolvedPane] = output.split("\n").map((part) => part.trim());
    if (tmuxSession && resolvedPane) {
      return {
        attachmentType: "tmux",
        tmuxSession,
        tmuxWindow: tmuxWindow || undefined,
        tmuxPane: resolvedPane,
      };
    }
  } catch {
    // 无法解析 tmux 元数据时回退到 external_cli。
  }

  return { attachmentType: "external_cli" };
}

export function attachCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("attach").description("把当前 shell 或智能体挂载到某个工作组节点");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .requiredOption("--self", "挂载当前 shell/智能体（v1 中必填）")
    .requiredOption("--rig <rigId>", "目标工作组 ID")
    .option("--node <logicalId>", "挂载到已有的逻辑节点")
    .option("--pod <namespace>", "在已有 pod 中新建成员完成挂载")
    .option("--member <name>", "pod 挂载模式下的成员名")
    .option("--runtime <runtime>", "pod 挂载模式使用的运行时；node 模式下为可选校验")
    .option("--cwd <path>", "要记录的工作目录", process.cwd())
    .option("--display-name <name>", "要记录的外部会话/显示名")
    .option("--print-env", "打印 OPENRIG_NODE_ID 与 OPENRIG_SESSION_NAME 的 shell export 语句")
    .option("--json", "以 JSON 输出")
    .action(async (opts: {
      self?: boolean;
      rig: string;
      node?: string;
      pod?: string;
      member?: string;
      runtime?: string;
      cwd?: string;
      displayName?: string;
      printEnv?: boolean;
      json?: boolean;
    }) => {
      if (!opts.self) {
        console.error("目前只支持 --self。用法：zrig attach --self ...");
        process.exitCode = 1;
        return;
      }
      if (opts.json && opts.printEnv) {
        console.error("--json 与 --print-env 只能二选一。");
        process.exitCode = 1;
        return;
      }

      const hasNode = !!opts.node;
      const hasPodFields = !!opts.pod || !!opts.member || !!opts.runtime;
      if (hasNode && hasPodFields) {
        console.error("--node 与 --pod + --member + --runtime 只能二选一。");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && !hasPodFields) {
        console.error("请指定 --node <logicalId>，或 --pod <namespace> --member <name> --runtime <runtime>。");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && (!opts.pod || !opts.member || !opts.runtime)) {
        console.error("pod 挂载必须同时提供 --pod <namespace> --member <name> --runtime <runtime>。");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const body: Record<string, unknown> = {
        cwd: opts.cwd ?? process.cwd(),
      };
      if (opts.runtime) body["runtime"] = opts.runtime;

      const attachContext = resolveAttachContext();
      body["attachmentType"] = attachContext.attachmentType;
      if (attachContext.attachmentType === "tmux") {
        body["tmuxSession"] = attachContext.tmuxSession;
        if (attachContext.tmuxWindow) body["tmuxWindow"] = attachContext.tmuxWindow;
        body["tmuxPane"] = attachContext.tmuxPane;
      } else if (opts.displayName) {
        body["displayName"] = opts.displayName;
      }

      if (hasNode) {
        body["logicalId"] = opts.node;
      } else {
        body["podNamespace"] = opts.pod;
        body["memberName"] = opts.member;
      }

      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(opts.rig)}/attach-self`, body);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `挂载失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      const env = (res.data["env"] ?? {}) as Record<string, unknown>;
      const nodeId = typeof env["OPENRIG_NODE_ID"] === "string" ? env["OPENRIG_NODE_ID"] : "";
      const sessionName = typeof env["OPENRIG_SESSION_NAME"] === "string" ? env["OPENRIG_SESSION_NAME"] : "";

      if (opts.printEnv) {
        console.log(`export OPENRIG_NODE_ID=${shellQuote(nodeId)}`);
        console.log(`export OPENRIG_SESSION_NAME=${shellQuote(sessionName)}`);
        return;
      }

      const logicalId = String(res.data["logicalId"] ?? opts.node ?? `${opts.pod}.${opts.member}`);
      if (hasNode) {
        console.log(`已把当前 shell 挂载到工作组 ${opts.rig} 的节点 ${logicalId}`);
      } else {
        console.log(`已在工作组 ${opts.rig} 中创建节点 ${logicalId} 并挂载当前 shell`);
      }
      console.log(`会话：      ${sessionName}`);
      console.log(`传输方式：  ${
        res.data["attachmentType"] === "tmux"
          ? "tmux"
          : "external_cli（可主动发起工作组命令；无入站 tmux 传输）"
      }`);
      console.log("身份标识：用 --print-env 重跑并 eval 输出，即可持久化 OPENRIG_NODE_ID/OPENRIG_SESSION_NAME");
    });

  return cmd;
}
