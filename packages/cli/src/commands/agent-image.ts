// Fork 原语 + Starter Agent Images v0（PL-016）—— `rig agent-image`
// CLI 动词族。与 `rig context`（上下文包库，PL-014 交付；Atom-7 中语法从
// `rig context-pack` 改名）并列。
//
// 子命令：
//   create   <source-session> --name <name>     —— 从运行中席位捕获镜像
//   list                                         —— 列出所有镜像
//   show     <name-or-id>                        —— manifest + 统计
//   preview  <name-or-id>                        —— 组装预览 + starter 片段
//   delete   <name-or-id> [--force]              —— 删除（受证据守卫约束）
//   pin      <name-or-id>                        —— 固定，防 prune
//   unpin    <name-or-id>                        —— 取消固定
//   prune    [--force] [--dry-run] [--json]      —— 批量删除可驱逐镜像
//   sync                                         —— 重走发现根目录

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface AgentImageEntryWire {
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  sourceSessionId: string;
  notes: string | null;
  createdAt: string;
  sourceType: "user_file" | "workspace" | "builtin";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: Array<{
    path: string;
    role: string;
    summary: string | null;
    absolutePath: string | null;
    bytes: number | null;
    estimatedTokens: number | null;
  }>;
  sourceResumeToken: string;
  stats: {
    forkCount: number;
    lastUsedAt: string | null;
    estimatedSizeBytes: number;
    lineage: string[];
  };
  lineage: string[];
  pinned: boolean;
}

interface PreviewWire extends Omit<AgentImageEntryWire, "sourcePath" | "relativePath" | "updatedAt" | "kind" | "sourceResumeToken" | "sourceType"> {
  starterSnippet: string;
}

interface PruneWire {
  dryRun: boolean;
  forced?: boolean;
  protected?: Array<{
    imageId: string;
    imageName: string;
    imageVersion: string;
    reasons: string[];
    references: string[];
  }>;
  evictable?: Array<{ imageId: string; imageName: string; imageVersion: string }>;
  deleted?: string[];
  errors?: Array<{ imageId: string; error: string }>;
}

async function resolveImage(client: DaemonClient, nameOrId: string): Promise<AgentImageEntryWire> {
  if (nameOrId.startsWith("agent-image:")) {
    const res = await client.get<AgentImageEntryWire>(`/api/agent-images/library/${encodeURIComponent(nameOrId)}`);
    if (res.status === 200) return res.data;
    if (res.status === 404) throw new Error(`库中未找到智能体镜像 '${nameOrId}'。运行 'rig agent-image list' 查看已安装内容。`);
    throw new Error(`后台服务对 /api/agent-images/library/${nameOrId} 返回 HTTP ${res.status}`);
  }
  const res = await client.get<AgentImageEntryWire[]>("/api/agent-images/library");
  if (res.status !== 200) throw new Error(`后台服务对 /api/agent-images/library 返回 HTTP ${res.status}`);
  const matches = (res.data ?? []).filter((e) => e.name === nameOrId);
  if (matches.length === 0) {
    throw new Error(`库中未找到智能体镜像 '${nameOrId}'。运行 'rig agent-image list' 查看已安装内容。`);
  }
  if (matches.length > 1) {
    const versions = matches.map((m) => m.version).join(", ");
    throw new Error(`智能体镜像 '${nameOrId}' 有歧义（版本：${versions}）。请使用 'agent-image:${nameOrId}:<version>'。`);
  }
  return matches[0]!;
}

export function agentImageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("agent-image")
    .description("浏览、快照并管理智能体镜像（PL-016）")
    .addHelpText("after", `
示例：
  zrig agent-image list
  zrig agent-image show driver-release-primed
  zrig agent-image create velocity-driver@openrig-velocity --name driver-release-primed --notes "评审后"
  zrig agent-image preview driver-release-primed
  zrig agent-image pin driver-release-primed
  zrig agent-image prune --dry-run
  zrig agent-image delete driver-release-primed --force
`);

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

  cmd.command("list")
    .description("列出库中所有智能体镜像")
    .option("--runtime <runtime>", "按运行时过滤（claude-code | codex）")
    .option("--json", "JSON 输出")
    .action(async (opts: { runtime?: string; json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<AgentImageEntryWire[]>("/api/agent-images/library");
        let entries = res.data ?? [];
        if (opts.runtime) entries = entries.filter((e) => e.runtime === opts.runtime);
        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log("暂无智能体镜像。用以下命令捕获一个：zrig agent-image create <source-session> --name <name>");
          return;
        }
        for (const e of entries) {
          const pinned = e.pinned ? " 📌" : "";
          console.log(`${e.name.padEnd(28)} v${String(e.version).padEnd(6)} ${e.runtime.padEnd(12)} 分叉：${String(e.stats.forkCount).padStart(3)}  约 ${String(e.derivedEstimatedTokens).padStart(6)} token  ${e.sourceType}${pinned}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("show")
    .argument("<name-or-id>", "镜像名或库 id")
    .option("--json", "JSON 输出")
    .description("显示镜像 manifest + 统计")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveImage(client, nameOrId);
        if (opts.json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }
        console.log(`名称：      ${entry.name}`);
        console.log(`版本：      ${entry.version}`);
        console.log(`运行时：    ${entry.runtime}`);
        console.log(`来源：      ${entry.sourceSeat}`);
        console.log(`创建时间：  ${entry.createdAt}`);
        console.log(`路径：      ${entry.sourcePath}`);
        console.log(`Token(约)： ${entry.derivedEstimatedTokens}${entry.manifestEstimatedTokens !== null ? `（manifest：${entry.manifestEstimatedTokens}）` : ""}`);
        console.log(`已固定：    ${entry.pinned}`);
        console.log("");
        console.log("统计：");
        console.log(`  fork 次数：        ${entry.stats.forkCount}`);
        console.log(`  最近使用：         ${entry.stats.lastUsedAt ?? "从未"}`);
        console.log(`  估计大小：         ${entry.stats.estimatedSizeBytes} 字节`);
        console.log(`  谱系：             ${entry.lineage.length === 0 ? "（无）" : entry.lineage.join(" → ")}`);
        if (entry.notes) {
          console.log("");
          console.log("备注：");
          console.log(`  ${entry.notes.replaceAll("\n", "\n  ")}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("preview")
    .argument("<name-or-id>", "镜像名或库 id")
    .option("--json", "JSON 输出")
    .description("显示 manifest + 带尺寸的补充文件元数据 + starter 片段")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveImage(client, nameOrId);
        const res = await client.get<PreviewWire>(`/api/agent-images/library/${encodeURIComponent(entry.id)}/preview`);
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        const preview = res.data;
        if (opts.json) {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        console.log(`# 预览：${preview.name} v${preview.version}（${preview.runtime}）`);
        console.log(`# 来源席位：${preview.sourceSeat}`);
        console.log(`# 统计：fork=${preview.stats.forkCount}, 最近使用=${preview.stats.lastUsedAt ?? "从未"}, 大小=${preview.stats.estimatedSizeBytes}B`);
        if (preview.lineage.length > 0) console.log(`# 谱系：${preview.lineage.join(" → ")}`);
        console.log("");
        console.log("# starter 片段（粘贴到 agent.yaml）：");
        console.log(preview.starterSnippet);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("create")
    .argument("<source-session>", "源会话规范名（例如 velocity-driver@openrig-velocity）")
    .description("把一个高产席位的可恢复状态捕获为新智能体镜像")
    .requiredOption("--name <name>", "镜像名（用作目录名与库 id）")
    // 用 --image-version 而非 --version，因为 Commander.js
    // 会拦截全局 --version 标志（打印 CLI 版本并静默退出 0）。
    // 逐命令命名解决冲突，又不丢失全局 --version 接口。
    .option("--image-version <version>", "镜像版本（默认：1）")
    .option("--notes <text>", "操作者提供、保留在 manifest 中的备注")
    .option("--estimated-tokens <n>", "操作者提供的 token 估计")
    .option("--lineage <names...>", "若从另一镜像 fork，逗号分隔的父镜像名")
    .option("--json", "JSON 输出")
    .action(async (sourceSession: string, opts: {
      name: string;
      imageVersion?: string;
      notes?: string;
      estimatedTokens?: string;
      lineage?: string[];
      json?: boolean;
    }) => {
      try {
        const client = await getClient();
        const body: Record<string, unknown> = {
          sourceSession,
          name: opts.name,
        };
        if (opts.imageVersion) body["version"] = opts.imageVersion;
        if (opts.notes) body["notes"] = opts.notes;
        if (opts.estimatedTokens) {
          const n = Number(opts.estimatedTokens);
          if (Number.isFinite(n)) body["estimatedTokens"] = n;
        }
        if (opts.lineage && opts.lineage.length > 0) body["lineage"] = opts.lineage;
        const res = await client.post<{ imageId: string; imagePath: string; manifest: { name: string; version: string; runtime: string } }>(
          "/api/agent-images/snapshot",
          body,
        );
        if (res.status !== 200) {
          const data = res.data as Partial<{ error: string; message: string; details: unknown }>;
          throw new Error(data.message ?? data.error ?? `后台服务返回 HTTP ${res.status}`);
        }
        const r = res.data;
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log(`已在 ${r.imagePath} 捕获 ${r.manifest.name} v${r.manifest.version}（${r.manifest.runtime}）`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("delete")
    .argument("<name-or-id>", "镜像名或库 id")
    .option("--force", "覆盖证据保留守卫（若存在活跃引用则灾难性）")
    .option("--json", "JSON 输出")
    .description("删除一个智能体镜像（受证据保留守卫约束）")
    .action(async (nameOrId: string, opts: { force?: boolean; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveImage(client, nameOrId);
        const url = `/api/agent-images/library/${encodeURIComponent(entry.id)}${opts.force ? "?force=true" : ""}`;
        const res = await client.delete<{ ok: boolean; forced: boolean; error?: string; message?: string; reasons?: string[] }>(url);
        if (res.status !== 200) {
          const data = res.data as Partial<{ error: string; message: string; reasons: string[] }>;
          throw new Error(data.message ?? data.error ?? `后台服务返回 HTTP ${res.status}`);
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        console.log(`已删除 ${entry.id}${opts.force ? "（强制）" : ""}。`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("pin")
    .argument("<name-or-id>", "镜像名或库 id")
    .option("--json", "JSON 输出")
    .description("固定一个镜像，使 prune 无法删除它")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveImage(client, nameOrId);
        const res = await client.post(`/api/agent-images/library/${encodeURIComponent(entry.id)}/pin`);
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        if (opts.json) console.log(JSON.stringify(res.data, null, 2));
        else console.log(`已固定 ${entry.id}。`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("unpin")
    .argument("<name-or-id>", "镜像名或库 id")
    .option("--json", "JSON 输出")
    .description("取消固定一个镜像")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveImage(client, nameOrId);
        const res = await client.post(`/api/agent-images/library/${encodeURIComponent(entry.id)}/unpin`);
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        if (opts.json) console.log(JSON.stringify(res.data, null, 2));
        else console.log(`已取消固定 ${entry.id}。`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("prune")
    .option("--dry-run", "预览而不删除（未 --force 时的默认）")
    .option("--force", "覆盖证据保留守卫（灾难性：会删除被引用的镜像）")
    .option("--json", "JSON 输出")
    .description("删除可驱逐镜像（受证据保留守卫保护）")
    .action(async (opts: { dryRun?: boolean; force?: boolean; json?: boolean }) => {
      try {
        const client = await getClient();
        const dryRun = opts.dryRun !== false && !opts.force;
        const res = await client.post<PruneWire>("/api/agent-images/prune", {
          dryRun,
          force: !!opts.force,
        });
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        const r = res.data;
        if (r.dryRun) {
          const protectedList = r.protected ?? [];
          const evictable = r.evictable ?? [];
          console.log(`（演练）${protectedList.length} 个受保护，${evictable.length} 个可驱逐`);
          if (protectedList.length > 0) {
            console.log("");
            console.log("受保护：");
            for (const p of protectedList) {
              console.log(`  ${p.imageName} v${p.imageVersion}：${p.reasons.join(", ")}`);
              for (const ref of p.references) console.log(`    ↪ ${ref}`);
            }
          }
          if (evictable.length > 0) {
            console.log("");
            console.log("可驱逐：");
            for (const e of evictable) console.log(`  ${e.imageName} v${e.imageVersion}`);
          }
        } else {
          console.log(`已删除 ${(r.deleted ?? []).length} 个镜像。${r.forced ? "（强制）" : ""}`);
          for (const err of r.errors ?? []) console.log(`  错误：${err.imageId}：${err.error}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("sync")
    .option("--json", "JSON 输出")
    .description("重走发现根目录并刷新库索引")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.post<{ count: number; errors: Array<{ source: string; error: string }>; entries: AgentImageEntryWire[] }>(
          "/api/agent-images/library/sync",
        );
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        console.log(`已索引 ${res.data.count} 个智能体镜像。`);
        for (const e of res.data.errors) console.log(`  错误：${e.source}：${e.error}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
