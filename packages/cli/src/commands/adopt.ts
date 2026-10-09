import nodePath from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { ImportDeps } from "./import.js";

interface DiscoveredSessionLike {
  id: string;
  tmuxSession: string;
}

interface BindingMapping {
  logicalId: string;
  selector: string;
}

interface BindingsFileShape {
  bindings?: Record<string, unknown>;
}

interface AdoptBindingResult {
  logicalId: string;
  selector: string;
  sessionName?: string;
  discoveredId?: string;
  ok: boolean;
  error?: string;
}

export interface AdoptDeps extends ImportDeps {}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseBinding(value: string): BindingMapping {
  const splitIndex = value.indexOf("=");
  if (splitIndex <= 0 || splitIndex === value.length - 1) {
    throw new Error(`无效的 --bind 映射 "${value}"。格式应为 logicalId=tmuxSessionOrDiscoveryId`);
  }
  return {
    logicalId: value.slice(0, splitIndex).trim(),
    selector: value.slice(splitIndex + 1).trim(),
  };
}

function parseBindingsFile(yaml: string): BindingMapping[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    throw new Error("绑定文件必须是有效的 YAML。修复：修好该文件后重试。");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("绑定文件必须是一个带有顶层 'bindings' 映射的对象。");
  }

  const bindings = (parsed as BindingsFileShape).bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("绑定文件必须把 'bindings' 定义为 logicalId: tmuxSessionOrDiscoveryId 的映射。");
  }

  return Object.entries(bindings).map(([logicalId, selector]) => {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error(`绑定文件条目 '${logicalId}' 必须映射到一个非空的会话选择器。`);
    }
    return { logicalId: logicalId.trim(), selector: selector.trim() };
  });
}

function findDiscoveredSession(sessions: DiscoveredSessionLike[], selector: string): DiscoveredSessionLike | undefined {
  return sessions.find((session) => session.id === selector || session.tmuxSession === selector);
}

export function adoptCommand(depsOverride?: AdoptDeps): Command {
  const cmd = new Command("adopt").description("物化拓扑并绑定已发现的运行中会话");
  const getDeps = (): AdoptDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "Pod 感知的 RigSpec 或片段的路径")
    .option("--bind <logicalId=tmuxSessionOrDiscoveryId>", "把一个逻辑节点绑定到已发现的 tmux 会话或发现 ID", collectOption, [])
    .option("--bindings-file <path>", "从 YAML 加载 logicalId -> tmux 会话/发现 ID 的映射")
    .option("--target-rig <rigId>", "用于增量物化的目标已有工作组")
    .option("--rig-root <root>", "供 Pod 感知解析的根目录")
    .option("--json", "输出机器可读的 JSON")
    .action(async (filePath: string, opts: { bind?: string[]; bindingsFile?: string; targetRig?: string; rigRoot?: string; json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(yaml);
      } catch {
        console.error("adopt 需要一个有效的 Pod 感知 RigSpec。修复：校验 YAML 后重试。");
        process.exitCode = 1;
        return;
      }
      const podAware = !!parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["pods"]);
      if (!podAware) {
        console.error("adopt 需要一个带 pods 的 Pod 感知 RigSpec。");
        process.exitCode = 1;
        return;
      }

      const inlineBindings = opts.bind ?? [];
      if (inlineBindings.length > 0 && opts.bindingsFile) {
        console.error("请选择 --bind 或 --bindings-file，二者不可同时使用。");
        process.exitCode = 1;
        return;
      }
      if (inlineBindings.length === 0 && !opts.bindingsFile) {
        console.error("adopt 至少需要一条绑定。请使用 --bind 或 --bindings-file。");
        process.exitCode = 1;
        return;
      }

      let bindings: BindingMapping[];
      try {
        if (opts.bindingsFile) {
          bindings = parseBindingsFile(deps.readFile(opts.bindingsFile));
        } else {
          bindings = inlineBindings.map(parseBinding);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const rigRoot = opts.rigRoot ? nodePath.resolve(opts.rigRoot) : nodePath.dirname(nodePath.resolve(filePath));

      const materializeHeaders: Record<string, string> = {
        "X-Rig-Root": rigRoot,
        ...(opts.targetRig ? { "X-Target-Rig-Id": opts.targetRig } : {}),
      };

      const materializeRes = await client.postText<{
        rigId: string;
        specName: string;
        specVersion: string;
        nodes: Array<{ logicalId: string; status: string }>;
      } | { error?: string; message?: string; errors?: string[] }>(
        "/api/rigs/import/materialize",
        yaml,
        "text/yaml",
        materializeHeaders,
      );

      if (materializeRes.status >= 400) {
        const data = materializeRes.data as { error?: string; message?: string; errors?: string[] };
        console.error(data.errors?.join("\n") ?? data.message ?? data.error ?? `物化失败（HTTP ${materializeRes.status}）`);
        process.exitCode = 1;
        return;
      }

      const materialized = materializeRes.data as {
        rigId: string;
        specName: string;
        specVersion: string;
        nodes: Array<{ logicalId: string; status: string }>;
      };

      const scanRes = await client.post<{ sessions?: Array<Record<string, unknown>>; error?: string }>("/api/discovery/scan", {});
      if (scanRes.status >= 400) {
        console.error(scanRes.data["error"] ?? `发现扫描失败（HTTP ${scanRes.status}）`);
        process.exitCode = 1;
        return;
      }

      const discoveryRes = await client.get<DiscoveredSessionLike[]>("/api/discovery?status=active");
      if (discoveryRes.status >= 400) {
        console.error(`读取发现清单失败（HTTP ${discoveryRes.status}）。请运行 zrig discover 后重试。`);
        process.exitCode = 1;
        return;
      }

      const activeSessions = Array.isArray(discoveryRes.data) ? discoveryRes.data : [];
      const results: AdoptBindingResult[] = [];

      for (const binding of bindings) {
        const session = findDiscoveredSession(activeSessions, binding.selector);
        if (!session) {
          results.push({
            logicalId: binding.logicalId,
            selector: binding.selector,
            ok: false,
            error: `在活跃发现中未找到会话 "${binding.selector}"`,
          });
          continue;
        }

        const bindRes = await client.post<Record<string, unknown>>(`/api/discovery/${encodeURIComponent(session.id)}/bind`, {
          rigId: materialized.rigId,
          logicalId: binding.logicalId,
        });

        if (bindRes.status >= 400) {
          results.push({
            logicalId: binding.logicalId,
            selector: binding.selector,
            sessionName: session.tmuxSession,
            discoveredId: session.id,
            ok: false,
            error: String(bindRes.data["error"] ?? `绑定失败（HTTP ${bindRes.status}）`),
          });
          continue;
        }

        results.push({
          logicalId: binding.logicalId,
          selector: binding.selector,
          sessionName: session.tmuxSession,
          discoveredId: session.id,
          ok: true,
        });
      }

      const payload = {
        rigId: materialized.rigId,
        specName: materialized.specName,
        specVersion: materialized.specVersion,
        materializedNodes: materialized.nodes,
        bindings: results,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`已采纳工作组：${materialized.specName}（${materialized.rigId}）`);
        for (const node of materialized.nodes) {
          console.log(`  ${node.logicalId}：${node.status}`);
        }
        for (const result of results) {
          if (result.ok) {
            console.log(`  绑定 ${result.logicalId} <- ${result.sessionName ?? result.selector}：已绑定`);
          } else {
            console.error(`  绑定 ${result.logicalId} <- ${result.selector}：${result.error}`);
          }
        }
      }

      if (results.some((result) => !result.ok)) {
        if (!opts.json) {
          console.error("adopt 完成但有错误。修复：运行 zrig discover --json，校正映射后重试失败的绑定。");
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
