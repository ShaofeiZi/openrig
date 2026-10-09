// rig plugin CLI 动词族——只读插件检视。
//
// 依据 IMPL-PRD §4 plugin-primitive Phase 3a slice 3.4 + DESIGN.md §6
// （CLI 极简主义：4 个只读检视命令）。
//
// slice 3.4 范围内的子命令（本次提交）：
//   list                —— 可发现插件的聚合视图
//                         标志：--runtime claude|codex
//                                --source vendored|claude-cache|codex-cache
//                                --json
//   show <id>           —— 检视 manifest + skills + hooks + mcp 服务器
//                         标志：--json
//   used-by <id>        —— 引用本插件的智能体
//                         标志：--json
//   validate <path>     —— 对插件源码树做本地文件检视
//                         （按 agentskills.io 校验 manifest 形状 + skill frontmatter）
//                         标志：--json
//
// list/show 消费 slice 3.3 后台服务 HTTP 路由（GET /api/plugins[/...]）。
//
// 按既定 building-agent-software + IMPL-PRD §4.4 HG-4.5，所有命令都附带
// --json 输出供智能体消费。
//
// 线上形状逐字镜像 slice 3.3 PluginDiscoveryService 的导出
// （packages/daemon/src/domain/plugin-discovery-service.ts L41-132）。这里的类型
// 是线上契约；一旦与后台服务源码漂移，说明后台服务形状变了，本文件必须同步更新。
//
// v0 暂不支持的标志（按 velocity-guard 3.4.A blocker 推迟）：
//   --used  —— PRD §4.2 中有声明，但后台服务路由不暴露"按被某智能体引用过滤插件"
//             的过滤；需要在客户端对 /api/plugins + /api/plugins/:id/used-by
//             做 N+1 后过滤。不在 v0 范围。
//   --tree  —— PRD §4.2 中有声明，但 show 输出已打印树结构
//             （manifests + skills + hooks + mcp）。独立的纯树模式是 v0 之后的打磨。
//   --source rig-cwd —— 后台路由的 parseSourceFilter 不接受 rig-cwd；
//             rig-cwd 扫描通过单独的 ?cwd=<path> 查询启用（v0 不在范围，因为
//             CLI 还没有"扫描本工作组 cwd"的入口）。
//   --runtime both —— 后台 parseRuntimeFilter 只接受 claude|codex；省略
//             --runtime 返回全部（"both"语义即默认不过滤）。
// 这些入口各自在未来 slice 中出现；CLI 标志声明严格限定在后台服务实际支持的范围。

import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// 按 slice-3.3 后台路由校验的过滤值枚举
// （packages/daemon/src/routes/plugins.ts L37-58）。CLI 侧校验给操作者清晰的错误，
// 而不是在后台路由忽略未知值时静默放行。
const VALID_RUNTIMES = ["claude", "codex"] as const;
const VALID_SOURCES = ["vendored", "claude-cache", "codex-cache"] as const;

// ============================================================
// 线上形状——必须逐字镜像 PluginDiscoveryService
// （packages/daemon/src/domain/plugin-discovery-service.ts L41-132）
// ============================================================

type PluginRuntime = "claude" | "codex";
type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache" | "rig-cwd";

interface PluginEntryWire {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: PluginSourceKind;
  sourceLabel: string;
  runtimes: PluginRuntime[];
  path: string;
  lastSeenAt: string | null;
}

interface PluginManifestSummaryWire {
  raw: Record<string, unknown>;
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

interface PluginSkillSummaryWire {
  name: string;
  relativePath: string;
}

interface PluginHookSummaryWire {
  runtime: PluginRuntime;
  relativePath: string;
  events: string[];
}

interface PluginMcpServerSummaryWire {
  runtime: PluginRuntime;
  name: string;
  command: string | null;
  transport: string | null;
}

interface PluginDetailWire {
  entry: PluginEntryWire;
  claudeManifest: PluginManifestSummaryWire | null;
  codexManifest: PluginManifestSummaryWire | null;
  skills: PluginSkillSummaryWire[];
  hooks: PluginHookSummaryWire[];
  mcpServers: PluginMcpServerSummaryWire[];
}

// AgentReference 逐字对应 PluginDiscoveryService L134-141。
interface AgentReferenceWire {
  agentName: string;
  sourcePath: string;
  profiles: string[];
}

export function pluginCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("plugin");
  cmd.description("检视插件（只读）");

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b：通过同一个助手给出与认知状态匹配的措辞（宕 ≠ 忙）。
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // -- zrig plugin list --
  cmd.command("list")
    .description("列出可发现插件（跨 vendored + 运行时缓存聚合）")
    .option("--runtime <runtime>", "按运行时支持过滤：claude | codex（省略则全部）")
    .option("--source <source>", "按来源过滤：vendored | claude-cache | codex-cache")
    .option("--json", "JSON 输出")
    .action(async (opts: { runtime?: string; source?: string; json?: boolean }) => {
      try {
        // 按 velocity-guard 3.4.A 修复结论在收尾时加入的 CLI 侧过滤值校验：
        // 像 --source rig-cwd 这样的拼写错误应大声失败，而不是被后台路由静默忽略。
        if (opts.runtime && !(VALID_RUNTIMES as readonly string[]).includes(opts.runtime)) {
          throw new Error(`无效的 --runtime 值 "${opts.runtime}"。合法值：${VALID_RUNTIMES.join(" | ")}（省略标志表示全部）`);
        }
        if (opts.source && !(VALID_SOURCES as readonly string[]).includes(opts.source)) {
          throw new Error(`无效的 --source 值 "${opts.source}"。合法值：${VALID_SOURCES.join(" | ")}`);
        }

        const client = await getClient();
        const params: string[] = [];
        if (opts.runtime) params.push(`runtime=${encodeURIComponent(opts.runtime)}`);
        if (opts.source) params.push(`source=${encodeURIComponent(opts.source)}`);
        const path = `/api/plugins${params.length > 0 ? `?${params.join("&")}` : ""}`;
        const res = await client.get<PluginEntryWire[]>(path);
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log("未发现插件。");
          return;
        }

        for (const e of entries) {
          const runtimesStr = e.runtimes.join(",");
          // 只展示真实字段：id、version、runtimes、sourceLabel、path
          console.log(
            `${e.id.padEnd(28)} v${String(e.version).padEnd(8)} ` +
            `[${runtimesStr.padEnd(13)}] ${e.sourceLabel.padEnd(36)} ` +
            `${e.path}`
          );
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- zrig plugin show <id> --
  cmd.command("show")
    .argument("<id>", "插件 id（例如 openrig-core）")
    .description("展示插件 manifest + skills + hooks + mcp 服务器")
    .option("--json", "JSON 输出")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<PluginDetailWire>(`/api/plugins/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          throw new Error(`未找到插件："${id}"`);
        }
        if (res.status !== 200 || !res.data) {
          throw new Error(`后台服务返回 HTTP ${res.status}`);
        }
        const detail = res.data;

        if (opts.json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }

        const entry = detail.entry;
        console.log(`Id：          ${entry.id}`);
        console.log(`名称：        ${entry.name}`);
        console.log(`版本：        ${entry.version}`);
        console.log(`描述：        ${entry.description ?? "（无）"}`);
        console.log(`来源：        ${entry.sourceLabel}`);
        console.log(`路径：        ${entry.path}`);
        console.log(`运行时：      ${entry.runtimes.join(", ")}`);
        if (entry.lastSeenAt) {
          console.log(`最近出现：    ${entry.lastSeenAt}`);
        }
        console.log("");

        // Manifests——真实的 PluginManifestSummary 字段
        console.log("Manifests：");
        if (detail.claudeManifest) {
          const m = detail.claudeManifest;
          const parts: string[] = [];
          if (m.name) parts.push(`name=${m.name}`);
          if (m.version) parts.push(`version=${m.version}`);
          if (m.license) parts.push(`license=${m.license}`);
          if (m.repository) parts.push(`repo=${m.repository}`);
          console.log(`  claude:    ${parts.join(" ") || "（存在）"}`);
        }
        if (detail.codexManifest) {
          const m = detail.codexManifest;
          const parts: string[] = [];
          if (m.name) parts.push(`name=${m.name}`);
          if (m.version) parts.push(`version=${m.version}`);
          if (m.license) parts.push(`license=${m.license}`);
          if (m.repository) parts.push(`repo=${m.repository}`);
          console.log(`  codex:     ${parts.join(" ") || "（存在）"}`);
        }
        if (!detail.claudeManifest && !detail.codexManifest) {
          console.log("  （无）");
        }

        // Skills——PluginSkillSummary 只有 name + relativePath
        console.log("");
        console.log(`Skills（${detail.skills.length}）：`);
        for (const s of detail.skills) {
          console.log(`  ${s.name.padEnd(40)} ${s.relativePath}`);
        }

        // Hooks——PluginHookSummary 有 runtime + relativePath + events[]
        console.log("");
        console.log(`Hooks（${detail.hooks.length}）：`);
        for (const h of detail.hooks) {
          const eventList = h.events.length > 0 ? h.events.join(",") : "（无）";
          console.log(`  ${h.runtime.padEnd(10)} ${String(h.events.length).padStart(2)} events  [${eventList}]  ${h.relativePath}`);
        }

        // MCP 服务器
        if (detail.mcpServers.length > 0) {
          console.log("");
          console.log(`MCP 服务器（${detail.mcpServers.length}）：`);
          for (const m of detail.mcpServers) {
            const detail2: string[] = [];
            if (m.transport) detail2.push(`transport=${m.transport}`);
            if (m.command) detail2.push(`command=${m.command}`);
            console.log(`  ${m.runtime.padEnd(10)} ${m.name.padEnd(28)} ${detail2.join(" ")}`);
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- zrig plugin used-by <id> --
  cmd.command("used-by")
    .argument("<id>", "插件 id（例如 openrig-core）")
    .description("列出在 profile.uses.plugins[] 中引用本插件的智能体")
    .option("--json", "JSON 输出")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<AgentReferenceWire[]>(`/api/plugins/${encodeURIComponent(id)}/used-by`);
        if (res.status !== 200) {
          throw new Error(`后台服务返回 HTTP ${res.status}`);
        }
        const refs = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(refs, null, 2));
          return;
        }

        if (refs.length === 0) {
          console.log(`没有智能体引用插件 "${id}"。`);
          return;
        }

        for (const r of refs) {
          const profilesStr = r.profiles.length > 0 ? r.profiles.join(",") : "（无）";
          console.log(`${r.agentName.padEnd(36)} [${profilesStr.padEnd(20)}] ${r.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // -- zrig plugin validate <path> --
  // 本地文件检视——不依赖后台服务；适用于在 feature 分支编写插件、
  // 而后台服务可能尚未发现该插件时。校验 manifest 形状（按 Claude/Codex 规范）
  // + skill frontmatter（按 agentskills.io：name + description ≤1024 字符）。
  cmd.command("validate")
    .argument("<path>", "要校验的插件源码目录")
    .description("按 agentskills.io 规范校验插件 manifest + skill frontmatter")
    .option("--json", "JSON 输出（{ valid: 布尔, errors: 字符串[] }）")
    .action((path: string, opts: { json?: boolean }) => {
      const errors = validatePluginTree(path);
      const valid = errors.length === 0;

      if (opts.json) {
        console.log(JSON.stringify({ valid, errors }, null, 2));
        process.exitCode = valid ? undefined : 1;
        return;
      }

      if (valid) {
        console.log(`位于 ${path} 的插件：有效`);
        return;
      }

      console.error(`位于 ${path} 的插件：无效（${errors.length} 个错误）`);
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
    });

  return cmd;
}

// ============================================================
// 校验管线——本地文件检视
// ============================================================

function validatePluginTree(pluginPath: string): string[] {
  const errors: string[] = [];

  if (!existsSync(pluginPath)) {
    errors.push(`插件路径不存在：${pluginPath}`);
    return errors;
  }
  if (!statSync(pluginPath).isDirectory()) {
    errors.push(`插件路径不是目录：${pluginPath}`);
    return errors;
  }

  const claudeManifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  const codexManifestPath = join(pluginPath, ".codex-plugin", "plugin.json");
  const hasClaude = existsSync(claudeManifestPath);
  const hasCodex = existsSync(codexManifestPath);

  if (!hasClaude && !hasCodex) {
    errors.push("未找到插件 manifest：应有 .claude-plugin/plugin.json 和/或 .codex-plugin/plugin.json");
    return errors;
  }

  if (hasClaude) {
    errors.push(...validateManifest(claudeManifestPath, "claude"));
  }
  if (hasCodex) {
    errors.push(...validateManifest(codexManifestPath, "codex"));
  }

  // 校验 skill frontmatter
  const skillsDir = join(pluginPath, "skills");
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const skillId of readdirSync(skillsDir)) {
      const skillMdPath = join(skillsDir, skillId, "SKILL.md");
      if (existsSync(skillMdPath)) {
        errors.push(...validateSkillFrontmatter(skillMdPath, skillId));
      }
    }
  }

  return errors;
}

function validateManifest(manifestPath: string, runtime: "claude" | "codex"): string[] {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    errors.push(`${runtime} manifest 解析错误，位于 ${manifestPath}：${(err as Error).message}`);
    return errors;
  }
  // 守卫非对象/null 解析结果——JSON.parse('null') 返回 null、
  // JSON.parse('[1,2]') 返回数组——两者都必须校验失败而非崩溃。
  if (!isPlainObject(parsed)) {
    errors.push(`${runtime} manifest（${manifestPath}）必须是 JSON 对象（实际得到 ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}）`);
    return errors;
  }
  const raw = parsed;
  if (typeof raw["name"] !== "string" || raw["name"].trim().length === 0) {
    errors.push(`${runtime} manifest 缺少必填字段：name（必须为非空字符串）`);
  }
  if (typeof raw["version"] !== "string" || raw["version"].trim().length === 0) {
    errors.push(`${runtime} manifest 缺少必填字段：version（必须为非空字符串）`);
  }
  // Codex 规范：description 必填。Claude 规范：description 推荐但非硬性要求；
  // 我们把缺 description 当作警告——仅 Claude 缺 description 不报错，
  // 而 Codex 缺 description 报错。
  if (runtime === "codex" && (typeof raw["description"] !== "string" || raw["description"].trim().length === 0)) {
    errors.push(`codex manifest 缺少必填字段：description（Codex 规范要求）`);
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSkillFrontmatter(skillPath: string, skillId: string): string[] {
  const errors: string[] = [];
  let content: string;
  try {
    content = readFileSync(skillPath, "utf-8");
  } catch (err) {
    errors.push(`skill "${skillId}"：读取 SKILL.md 失败：${(err as Error).message}`);
    return errors;
  }
  // Frontmatter：文件必须以 `---\n` 开头，并包含一行结束的 `---`
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    errors.push(`skill "${skillId}"：SKILL.md 缺少 frontmatter（必须以 --- ... --- 开头）`);
    return errors;
  }
  const fmBody = fmMatch[1] ?? "";

  // 把 frontmatter 当 YAML 解析——按 velocity-guard 3.4.C BLOCKING-CONCERN，
  // 基于正则的校验会放过引号包裹的空值、漏掉类型错误。
  let parsed: unknown;
  try {
    parsed = parseYaml(fmBody);
  } catch (err) {
    errors.push(`skill "${skillId}"：YAML frontmatter 非法：${(err as Error).message}`);
    return errors;
  }
  if (!isPlainObject(parsed)) {
    errors.push(`skill "${skillId}"：frontmatter 必须是 YAML 对象/映射（实际得到 ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}）`);
    return errors;
  }

  // 必填：name（trim 后为非空字符串）
  const name = parsed["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push(`skill "${skillId}"：frontmatter 缺少必填字段：name（必须为非空字符串）`);
  }

  // 必填：description（trim 后为非空字符串；按 agentskills.io ≤1024 字符）
  const description = parsed["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push(`skill "${skillId}"：frontmatter 缺少必填字段：description（必须为非空字符串）`);
  } else if (description.trim().length > 1024) {
    errors.push(`skill "${skillId}"：description 长度 ${description.trim().length} 字符超过 agentskills.io 的 1024 上限`);
  }

  return errors;
}
