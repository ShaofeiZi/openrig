// 控制套接字适配器——Phase-0 spike 裁决采纳的"可寻址屏幕 API"。
// 每行一个命令；每行获得一行 JSON 回复。
//
// 常设架构约束（架构负责人 spike 后评审；与
// BR-9 ACTIONS 守卫同类——套接字是命名边界侵蚀点）：
//   1. 每个套接字命令通过唯一解析器/变更路径
//      （parseCommand → dispatch）。绝无程序化快捷方式可在其外变更状态。
//   2. 套接字动词仅保持 OBSERVE / NAVIGATE / DRIVE-STRUCTURE。无
//      ACT/PRODUCE 动词到达此处，因为套接字是 API。任何
//      跨越任一行的扩展在构建前路由到架构负责人。
// 唯一非语法动词是 "state"——只读状态查询（OBSERVE）。
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCommand } from "./grammar.js";
import { serializeCommands } from "./commands/registry.js";
import type { ViewState, ViewStateStore } from "./types.js";

/** macOS sun_path 将 unix 套接字路径限制在 ~104 字节；留余量防护。 */
export const MAX_SOCKET_PATH_BYTES = 100;

export function describeState(state: ViewState) {
  const named = new Map(state.drill.map((item) => [item.kind, item.name]));
  const mission = state.scopesSelected?.mission ?? state.scopesMission ?? undefined;
  const slice = state.scopesSelected?.slice
    ?? (state.executionOpen?.startsWith("slice:") ? state.executionOpen.slice("slice:".length) : undefined);
  const parts = [
    `instance:${state.instanceId}`,
    `section:${state.section}`,
    ...state.drill.map((item) => `${item.kind}:${item.name}`),
    ...(mission ? [`mission:${mission}`] : []),
    ...(slice ? [`slice:${slice}`] : []),
  ];
  return {
    ok: !state.lastError,
    screen: state.section,
    drill: state.drill.map((d) => `${d.kind}:${d.name}`),
    filter: state.filter || undefined,
    viewTab: state.viewTab,
    timeZone: state.timeZone,
    timeZoneWarning: state.timeZoneWarning,
    timeZoneHelp: state.timeZoneHelp,
    recentEvent: state.recentOpen ?? undefined,
    address: {
      instance: state.instanceId,
      section: state.section,
      ...(named.get("host") ? { host: named.get("host") } : {}),
      ...(named.get("rig") ? { rig: named.get("rig") } : {}),
      ...(named.get("pod") ? { pod: named.get("pod") } : {}),
      ...(named.get("agent") ? { agent: named.get("agent") } : {}),
      ...(named.get("spec") ? { spec: named.get("spec") } : {}),
      ...(mission ? { mission } : {}),
      ...(slice ? { slice } : {}),
      path: parts.join("/"),
    },
    copyMode: state.copyMode,
    error: state.lastError ?? undefined,
  };
}

/** 默认套接字主目录遵循已发布的 OPENRIG_HOME 约定
 *（openrig 兼容：~/.openrig），上面叠加 herdr 风格环境覆盖。 */
export function defaultSocketPath(instanceId: string): string {
  const override = process.env["OPENRIG_TUI_SOCKET"];
  if (override) return override;
  const home = process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
  return path.join(home, "run", `tui-${instanceId}.sock`);
}

export interface ControlSocket {
  path: string;
  close(): Promise<void>;
}

export async function createControlSocket(options: {
  socketPath: string;
  view: ViewStateStore;
  onMutation?: () => void;
  /** I5——实时命令上下文供应者（来自 C3 检测器）；默认 standard。 */
  currentContext?: () => string;
}): Promise<ControlSocket> {
  const { socketPath, view, onMutation } = options;
  const currentContext = options.currentContext ?? (() => "standard");
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `套接字路径过长（${bytes} 字节；unix sun_path 上限 ~104）：${socketPath} — 使用短运行目录（默认：$OPENRIG_HOME/run）`,
    );
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // REGISTRY I4——第二个 OBSERVE 动词：带实时
        // 每会话可用性的注册表投影（一个序列化器，PM pin 2；上下文 pin 3）。只读——
        // 留在架构约束的 OBSERVE 类中，与 "state" 并列。
        if (line === "commands") {
          conn.write(
            JSON.stringify({ ok: true, instanceId: view.instanceId, commands: serializeCommands(currentContext()) }) + "\n",
          );
          continue;
        }
        if (line === "state") {
          conn.write(
            JSON.stringify({ ok: true, instanceId: view.instanceId, state: describeState(view.get()) }) + "\n",
          );
          continue;
        }
        // 唯一变更路径：语法 → dispatch。仅此而已。
        const next = view.dispatch(parseCommand(line, view.get().sections));
        conn.write(JSON.stringify(describeState(next)) + "\n");
        onMutation?.();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        path: socketPath,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
              res();
            });
          }),
      });
    });
  });
}
