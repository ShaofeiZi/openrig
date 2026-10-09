// Rig Context / 可组合上下文注入——`rig context` CLI 动词族
//（Atom-7 把已废弃的 `context-pack` 语法重命名为 `rig context`；
// pack 存储契约——kind/id/API/磁盘目录——不变）。
//
// 与 `rig specs` 平行、不投递的子命令：
//   list / show / preview / compose / add / rm / sync
//
// 每个子命令都经后台服务委派到 /api/context-packs/library/*。
// `add` 动词从 $OPENRIG_HOME/context/<name>/ 处的目录安装一个 pack——
// 无 host 软链契约，与 `rig specs add` 形态一致（仅普通文件；无软链）。

import { Command } from "commander";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertSafeInstallRef, assertTreeHasNoSymlinks, assertDestinationNamespaceContained, validateContextPackManifestForInstall } from "../lib/context-install.js";
import { addGitContext, inspectGitContext, updateGitContext } from "../lib/context-git.js";
import { ConfigStore } from "../config-store.js";
import { DaemonClient } from "../client.js";
import { enumArg } from "../cli-error.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { resolveWorkPosition, type WorkInstallPlan } from "../lib/work-install.js";
import {
  reconcileSkillLoadout,
  resolveSkillLoadout,
  type ReconcileSkillLoadoutResult,
  type SkillLoadout,
} from "@openrig/daemon/skill-loadout";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const contextRuntimeArg = enumArg(["claude-code", "claude", "codex"]);

interface ContextPackEntryWire {
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  /** OPR.0.5.6.10——来自后台服务 ATOM_TAXONOMIES 枚举的 pack 级分类。 */
  taxonomy: string;
  sourceType: "builtin" | "user_file" | "workspace";
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
}

function selectedIds(ids: string[], none: string): string {
  return ids.length > 0 ? ids.join(", ") : none;
}

function printWorkInstallSelectors(result: WorkInstallPlan, topologySkills: string[]): void {
  const world = result.systemWorld;
  const identity = world.id ? ` ${world.id}@${world.version}` : "";
  const path = world.manifestPath ? ` ${world.manifestPath}` : "";
  console.log(`系统  ${world.state} [${world.source}]${identity}${path}`);
  for (const selection of world.context) {
    const profiles = selection.profiles
      ? ` (${Object.entries(selection.profiles).map(([runtime, profile]) => `${runtime}=${profile}`).join(", ")})`
      : "";
    console.log(`上下文  系统=${selection.ref}${profiles}`);
  }
  console.log(`技能  系统=${selectedIds(world.skills, "（无）")}`);
  console.log(`技能  拓扑=${selectedIds(topologySkills, "（无）")}`);
  console.log(`技能  项目=${selectedIds(result.skills, "（无）")}`);
}

interface PreviewWire {
  id: string;
  name: string;
  version: string;
  bundleText: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
}

const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSafeTopologySegment(kind: "rig" | "seat", value: string): void {
  if (value === "." || value === ".." || !SAFE_REF_SEGMENT.test(value)) {
    throw new Error(`不安全的 ${kind} 段 '${value}'——拓扑地址要求一个有界的路径段`);
  }
}

function assertLocalGitClient(client: DaemonClient): void {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
    throw new Error("Git 源的选择/查看/更新请在后台服务主机上经其 loopback URL 运行；这些命令使用本地 Git 与文件系统路径。");
  }
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function fetchTextOrThrow(url: string, what: string): Promise<{ text: string; finalUrl: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`无法连到 ${what}（${url}）：${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`无法获取 ${what}（${url}）：HTTP ${res.status} ${res.statusText}`.trim());
  // res.url 是任何重定向之后的最终 url——声明的文件必须相对它解析，
  // 而不是调用方最初写的拼写（r2 MEDIUM-1）。
  return { text: await res.text(), finalUrl: res.url || url };
}

// OPR.0.5.3.7 R4——从 URL 安装一个 context pack。<url> 指向 pack 的
// manifest.yaml（结尾 '/' 视为 '<url>manifest.yaml'）；每个 files[].path
// 都相对该 manifest 抓取。构造即原子：一切先暂存到目标的临时兄弟目录，
// 再由一次 renameSync 发布，所以畸形 manifest、不可达 URL 或缺失的声明文件
// 都不会留下半成品 pack。刻意简单：无注册表、无缓存。
async function installPackFromUrl(
  url: string,
  overrideName: string | undefined,
  targetRoot: string,
): Promise<{ targetDir: string; installName: string }> {
  const manifestUrl = url.endsWith("/") ? `${url}manifest.yaml` : url;
  mkdirSync(targetRoot, { recursive: true });
  const staging = mkdtempSync(join(targetRoot, ".tmp-add-"));
  try {
    // 在触碰目标命名空间之前先抓取并校验 manifest。
    const { text: manifestText, finalUrl: finalManifestUrl } = await fetchTextOrThrow(manifestUrl, "manifest");
    writeFileSync(join(staging, "manifest.yaml"), manifestText);
    validateContextPackManifestForInstall(join(staging, "manifest.yaml"));
    const manifest = parseYaml(manifestText) as { name: string; files: Array<{ path: string }> };
    const installName = overrideName ?? manifest.name;
    assertSafeInstallRef(installName);
    assertDestinationNamespaceContained(targetRoot, installName);
    const targetDir = join(targetRoot, installName);
    if (existsSync(targetDir)) {
      throw new Error(`名为 '${installName}' 的 context pack 已存在于 ${targetDir}。先移除它，或用 --name 装到别的名字下。`);
    }
    // 相对 manifest 的最终 url（重定向之后）抓取每个声明文件，
    // 经平台 URL 解析器——绝不用调用方最初的拼写
    // （r2 MEDIUM-1：被重定向的 manifest 不得对着过期的请求 base 解析文件）。
    //
    // 边界（r2 HIGH-1）：new URL() 也会认绝对 f.path，且 manifest 校验器会把
    // URL 形状的值当文件系统相对路径接受。要求每个解析出的文件 URL 都待在
    // manifest 自己的目录下（同源 + 路径前缀），让陌生人提供的 manifest 永远
    // 无法让 add 跨源抓取或爬出它的 pack。base 末尾的斜杠用于防前缀兄弟
    // （'/pack' 对 '/pack-evil'）把戏。
    const manifestDirUrl = new URL("./", finalManifestUrl).href;
    for (const f of manifest.files) {
      const fileUrl = new URL(f.path, finalManifestUrl).href;
      if (!fileUrl.startsWith(manifestDirUrl)) {
        throw new Error(
          `manifest 文件 '${f.path}' 解析到 ${fileUrl}，在 pack 目录 ${manifestDirUrl} 之外。` +
            `声明的文件必须相对 manifest（不要绝对 URL，不要爬出 pack）。`,
        );
      }
      const { text: fileText } = await fetchTextOrThrow(fileUrl, `文件 '${f.path}'`);
      const dest = join(staging, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fileText);
    }
    // 重新校验磁盘上的暂存 pack，然后原子发布。
    validateContextPackManifestForInstall(join(staging, "manifest.yaml"));
    assertTreeHasNoSymlinks(staging);
    renameSync(staging, targetDir);
    return { targetDir, installName };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

async function resolvePack(client: DaemonClient, nameOrRef: string): Promise<ContextPackEntryWire> {
  if (nameOrRef.startsWith("context-pack:")) {
    throw new Error(
      "context pack 冒号 id 寻址（'context-pack:<name>:<version>'）已移除。" +
        "请改用它的路径式 ref 寻址（例如 'packs/compaction-restore'）。",
    );
  }
  if (nameOrRef.includes("/")) {
    const res = await client.get<ContextPackEntryWire & { error?: string; message?: string }>(
      `/api/context-packs/library/by-ref?ref=${encodeURIComponent(nameOrRef)}`,
    );
    if (res.status === 200) return res.data;
    if (res.status === 404) throw new Error(`context pack '${nameOrRef}' 在库中未找到。运行 'zrig context list' 查看可用项。`);
    if (res.status === 400) throw new Error(res.data?.message ?? `不安全的 context pack ref '${nameOrRef}'。`);
    throw new Error(`后台服务对 /api/context-packs/library/by-ref 返回 HTTP ${res.status}`);
  }
  const res = await client.get<ContextPackEntryWire[]>("/api/context-packs/library");
  if (res.status !== 200) throw new Error(`后台服务对 /api/context-packs/library 返回 HTTP ${res.status}`);
  const entries = res.data ?? [];
  const exactRef = entries.find((entry) => entry.relativePath === nameOrRef);
  if (exactRef) return exactRef;
  const matches = entries.filter((e) => e.name === nameOrRef);
  if (matches.length === 0) {
    throw new Error(`context pack '${nameOrRef}' 在库中未找到。运行 'zrig context list' 查看可用项。`);
  }
  if (matches.length > 1) {
    const refs = matches.map((entry) => entry.relativePath).join(", ");
    throw new Error(`context pack 名 '${nameOrRef}' 在多个 ref 间歧义：${refs}。请用路径式 ref 寻址。`);
  }
  return matches[0]!;
}

export function contextCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("context")
    .description("浏览、预览、组合并管理操作者编写的 context pack")
    .addHelpText("after", `
示例：
  zrig context list
  zrig context show pl-005-phase-a-priming
  zrig context preview pl-005-phase-a-priming
  zrig context add ./my-pack
  zrig context rm packs/compaction-restore
  zrig context sync
  zrig context profile world-public --situation fresh --runtime claude-code
  zrig context work-install --runtime claude-code
  zrig context trace --rig product-team --seat orch1-lead --name LEARNED.md
  zrig context trace --rig product-team --pod delivery --seat dev1-qa --name LEARNED.md
`);

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.command("work-install")
    .description("解析 System World 加上项目工作上下文与受管 skill 装载")
    .option("--project <id>", "workspace.yaml 中精确的项目 id")
    .option("--mission <id>", "所选项目下精确的 mission id")
    .option("--slice <id>", "所选 mission 下精确的 slice id")
    .option("--deliver", "附带每个已存在计划文件的确切内容")
    .option("--runtime <runtime>", "查看 claude-code（别名：claude）或 codex 的 skills", contextRuntimeArg)
    .option("--cwd <path>", "接收 skill 投影的智能体工作目录（默认：当前目录）")
    .option("--topology <ids>", "逗号分隔的 topology/profile skill 标识")
    .option("--apply-skills", "把所选 skills 对账进运行时 harness 目录")
    .option("--json", "JSON 输出")
    .action((opts: { project?: string; mission?: string; slice?: string; deliver?: boolean; runtime?: string; cwd?: string; topology?: string; applySkills?: boolean; json?: boolean }) => {
      if (opts.applySkills && opts.runtime === undefined) {
        console.error("invalid_runtime: --apply-skills 需要 --runtime claude-code（别名：claude）或 codex");
        process.exitCode = 1;
        return;
      }
      const store = new ConfigStore();
      const workspaceRoot = String(store.resolveWithSource("workspace.root").value);
      const catalogPath = String(store.resolveWithSource("workspace.catalog_path").value);
      const contextRoot = String(store.resolveWithSource("context.root").value);
      const systemWorldSetting = store.resolveWithSource("context.system_world");
      const result = resolveWorkPosition({
        workspaceRoot,
        catalogPath,
        contextRoot,
        systemWorldSelection: String(systemWorldSetting.value),
        systemWorldSource: systemWorldSetting.source,
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.mission !== undefined ? { mission: opts.mission } : {}),
        ...(opts.slice !== undefined ? { slice: opts.slice } : {}),
      });
      if ("error" in result) {
        if (opts.json) console.log(JSON.stringify({ ok: false, ...result }));
        else console.error(`${result.error.code}: ${result.error.message}`);
        process.exitCode = 1;
        return;
      }
      let skillLoadout: SkillLoadout | undefined;
      let skillProjection: ReconcileSkillLoadoutResult | undefined;
      if (opts.runtime) {
        const topologySkills = (opts.topology ?? "").split(",").map((id) => id.trim()).filter(Boolean);
        const resolvedSkills = resolveSkillLoadout({
          catalogRoot: String(store.resolveWithSource("skills.root").value),
          systemSkills: result.systemWorld.skills,
          topologySkills,
          projectRoot: result.position.projectRoot,
          projectSkills: result.skills,
        });
        if (!resolvedSkills.ok) {
          if (opts.json) console.log(JSON.stringify({ ok: false, errors: resolvedSkills.errors }, null, 2));
          else for (const error of resolvedSkills.errors) console.error(`${error.code}: ${error.message}`);
          process.exitCode = 1;
          return;
        }
        skillLoadout = resolvedSkills.loadout;
        skillProjection = reconcileSkillLoadout({
          loadout: skillLoadout,
          runtime: opts.runtime === "codex" ? "codex" : "claude-code",
          cwd: resolve(opts.cwd ?? process.cwd()),
          apply: opts.applySkills === true,
        });
        if (!skillProjection.ok) process.exitCode = 1;
      }
      if (opts.json) {
        const output = opts.deliver
          ? {
              ...result,
              pieces: result.pieces.map((piece) => piece.exists
                ? { ...piece, content: readFileSync(piece.path, "utf8") }
                : piece),
              ...(skillLoadout ? { skillLoadout, skillProjection } : {}),
            }
          : { ...result, ...(skillLoadout ? { skillLoadout, skillProjection } : {}) };
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      if (opts.deliver) {
        for (const planned of result.pieces) {
          if (!planned.exists) {
            console.log(`=== ${planned.address}（缺失：${planned.path}）===`);
            continue;
          }
          console.log(`=== ${planned.altitude} ${planned.address} ===`);
          console.log(readFileSync(planned.path, "utf8"));
        }
        printWorkInstallSelectors(result, (opts.topology ?? "").split(",").map((id) => id.trim()).filter(Boolean));
        if (skillProjection) {
          for (const receipt of skillProjection.receipts) {
            console.log(`${receipt.status.padEnd(7)} ${receipt.id} [${receipt.selectedBy.join("+")}] ${receipt.target}`);
          }
          for (const id of skillProjection.removed) console.log(`移除 ${id}`);
          if (skillProjection.freshLaunchRequired) console.log("skills  需要新的席位进程才能观察到已变更的环境 skills");
          if (!opts.applySkills) console.log("skills  只读；加 --apply-skills 才会对账");
        }
        for (const warning of result.warnings) console.error(`警告：${warning}`);
        return;
      }
      console.log(`项目 ${result.position.projectId ?? "（未在清单中）"}：${result.position.projectRoot}`);
      printWorkInstallSelectors(result, (opts.topology ?? "").split(",").map((id) => id.trim()).filter(Boolean));
      for (const planned of result.pieces) {
        console.log(`${planned.altitude.padEnd(7)} ${planned.address} [${planned.source}] ${planned.exists ? planned.path : `（缺失：${planned.path}）`}`);
      }
      if (skillProjection) {
        for (const receipt of skillProjection.receipts) {
          console.log(`${receipt.status.padEnd(7)} ${receipt.id} [${receipt.selectedBy.join("+")}] ${receipt.target}`);
        }
        for (const id of skillProjection.removed) console.log(`移除 ${id}`);
        if (skillProjection.freshLaunchRequired) console.log("skills  需要新的席位进程才能观察到已变更的环境 skills");
        if (!opts.applySkills) console.log("skills  只读；加 --apply-skills 才会对账");
      }
      for (const warning of result.warnings) console.error(`警告：${warning}`);
    });

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b：经同一 helper 使用与认知匹配的措辞（宕机 ≠ 忙）。
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // OPR.0.5.3.6——产品化的链文件 trace。设计上不依赖后台服务：
  // 遍历是一次配置读 + 若干文件系统读，所以在后台服务宕机的机器上也能用
  // （orientation 恰恰发生在那时）。
  cmd.command("trace")
    .description("为一个链文件名遍历拓扑树（instance -> rig -> 可选 pod -> 可选 seat），以 topology.root 为锚")
    .requiredOption("--rig <rig>", "Rig 名（rigs/<rig> 这一层）")
    .option("--pod <pod>", "Pod id（pods/<pod> 这一层）；未选 pod 上下文时省略")
    .option("--seat <seat>", "Seat id（seats/<seat> 这一层）；rig 级 trace 时省略")
    .requiredOption("--name <file>", "链文件名，每一层都同名（如 LEARNED.md、CULTURE.md）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { rig: string; pod?: string; seat?: string; name: string; json?: boolean }) => {
      const { ConfigStore } = await import("../config-store.js");
      const { traceTopologyChain } = await import("../lib/topology-trace.js");
      const store = new ConfigStore();
      const resolved = store.resolveWithSource("topology.root");
      let result;
      try {
        result = traceTopologyChain({
          topologyRoot: String(resolved.value),
          name: opts.name,
          rig: opts.rig,
          pod: opts.pod ?? null,
          seat: opts.seat ?? null,
        });
      } catch (err) {
        // r2-B3：遍历形状的输入是一次干净的拒绝，绝不抛栈。
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      // 提示在两种输出模式下都走 stderr——遗留读取绝不能静默通过，
      // 而 stdout 保持干净以便管道。
      for (const level of result.levels) {
        if (level.advisory) console.error(`ADVISORY ${level.advisory}`);
      }
      if (opts.json) {
        console.log(JSON.stringify({ topologyRootSource: resolved.source, ...result }, null, 2));
        return;
      }
      console.log(`拓扑链 "${result.name}"，位于 topology.root=${result.topologyRoot}（来源：${resolved.source}）`);
      for (const level of result.levels) {
        if (level.source === "absent") {
          console.log(`\n== ${level.altitude}——缺失（${level.path}）`);
          continue;
        }
        const origin = level.source === "legacy" ? ` [遗留：${level.resolvedPath}]` : "";
        console.log(`\n== ${level.altitude}——${level.path}${origin}`);
        console.log(level.content?.trimEnd() ?? "");
      }
    });

  cmd.command("compose")
    .description("把有序文件组合成一个持久 context-pack ref（绝不投递）")
    .requiredOption("--out <ref>", "路径式持久输出 ref")
    .requiredOption("--from <files...>", "有序的源文件")
    .action(async (opts: { out: string; from: string[] }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("后台服务未运行。用它启动：zrig daemon start");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));
      try {
        const res = await client.post<{
          ref?: string;
          bytes?: number;
          estimatedTokens?: number;
          files?: unknown[];
          error?: string;
          message?: string;
        }>("/api/context-packs/library/compose", {
          outRef: opts.out,
          sources: opts.from.map((path) => ({ path: resolve(path), label: path })),
        });
        if (res.status !== 201) {
          throw new Error(res.data.message ?? res.data.error ?? `后台服务返回 HTTP ${res.status}`);
        }
        console.log(
          `已组合 ${res.data.files?.length ?? opts.from.length} 个文件 -> ${res.data.ref} ` +
          `（${res.data.bytes ?? 0} 字节，约 ${res.data.estimatedTokens ?? 0} tokens）。`,
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("list")
    .description("列出库中所有 context pack")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<ContextPackEntryWire[]>("/api/context-packs/library");
        const entries = res.data ?? [];
        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log("库中没有 context pack。在 `zrig config get context.root` 下编写一个，然后运行：zrig context sync");
          return;
        }
        for (const e of entries) {
          console.log(`${e.relativePath.padEnd(36)} ${e.name.padEnd(24)} v${String(e.version).padEnd(6)} ${(e.taxonomy ?? "—").padEnd(8)} ${String(e.files.length).padStart(2)} 文件  约${String(e.derivedEstimatedTokens).padStart(6)} tokens  ${e.sourceType}  ${e.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("show")
    .argument("<name-or-ref>", "context pack 名或路径式 ref")
    .description("展示 pack manifest 与逐文件元数据")
    .option("--json", "JSON 输出")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrId);
        if (opts.json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }
        console.log(`Ref:        ${entry.relativePath}`);
        console.log(`名称：      ${entry.name}`);
        console.log(`版本：      ${entry.version}`);
        console.log(`来源：      ${entry.sourceType}（${entry.sourcePath}）`);
        console.log(`文件数：    ${entry.files.length}`);
        console.log(`Tokens(~):  ${entry.derivedEstimatedTokens}${entry.manifestEstimatedTokens !== null ? `（manifest：${entry.manifestEstimatedTokens}）` : ""}`);
        if (entry.purpose) {
          console.log("");
          console.log("用途：");
          console.log(`  ${entry.purpose.replaceAll("\n", "\n  ")}`);
        }
        console.log("");
        for (const f of entry.files) {
          const sizeStr = f.bytes === null ? "（缺失）" : `${f.bytes}B`;
          const tokenStr = f.estimatedTokens === null ? "—" : `约${f.estimatedTokens} tokens`;
          console.log(`  ${f.path.padEnd(40)} role=${f.role.padEnd(20)} ${sizeStr.padEnd(12)} ${tokenStr}`);
          if (f.summary) console.log(`    ${f.summary}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("preview")
    .argument("<name-or-ref>", "context pack 名或路径式 ref")
    .description("展示组装好的 bundle，但不投递")
    .option("--json", "JSON 输出")
    .action(async (nameOrRef: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrRef);
        const res = await client.get<PreviewWire>(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(entry.relativePath)}`);
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        const preview = res.data;
        if (opts.json) {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        if (preview.missingFiles.length > 0) {
          console.error(`警告：manifest 引用的 ${preview.missingFiles.length} 个文件在磁盘上缺失：`);
          for (const m of preview.missingFiles) console.error(`  - ${m.path}（role：${m.role}）`);
          console.error("");
        }
        console.log(`# 预览：${preview.name} v${preview.version}`);
        console.log(`# Bundle：${preview.bundleBytes} 字节（约 ${preview.estimatedTokens} tokens），${preview.files.length} 个文件`);
        console.log("# ---");
        console.log(preview.bundleText);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // OPR.0.5.3.7 R1——PULL 动词：一个面向智能体的服务动词，跑在既有的汇编器
  // 路径上（与 `preview` 用同一套 by-ref/preview 机制——绝不另起一个汇编器）。
  // `preview` 是操作者发送前的检查；`get` 是席位按需运行以加载一个
  // 库条目。输出就是组装好的 bundle 本身（让智能体恰好消费这些字节），
  // 警告走 stderr；`--json` 供程序化使用。命名裁定：`rig context get`
  // （一个库、一个动词——不是 `rig skills get`；"skills" 是库里的一个组织类别）。
  cmd.command("get")
    .argument("<name-or-ref>", "context 库条目名、路径式 ref，或地址（<pack-ref>/<file>#H2-slug/H3-slug）")
    .description("把组装好的 bundle 交给智能体按需加载（pull 动词）")
    .option("--json", "JSON 输出")
    .action(async (nameOrRef: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        // OPR.0.5.3.5 Atom 4c：带 fragment 的地址直接路由到后台服务的解析器。
        // 一个裸的含斜杠值可能是 pack ref 也可能是整文件地址，所以先精确 pack 查找，
        // 只有它 404 才落到同一个解析器。
        if (nameOrRef.includes("#")) {
          const res = await client.get<{ text?: string; message?: string; error?: string }>(
            `/api/context-packs/library/resolve-address?address=${encodeURIComponent(nameOrRef)}`,
          );
          if (res.status !== 200) {
            throw new Error(res.data?.message ?? res.data?.error ?? `后台服务对 resolve-address 返回 HTTP ${res.status}`);
          }
          if (opts.json) console.log(JSON.stringify(res.data, null, 2));
          else console.log(res.data.text);
          return;
        }
        let entry: ContextPackEntryWire;
        if (nameOrRef.includes("/")) {
          const exact = await client.get<ContextPackEntryWire & { error?: string; message?: string }>(
            `/api/context-packs/library/by-ref?ref=${encodeURIComponent(nameOrRef)}`,
          );
          if (exact.status === 404) {
            const res = await client.get<{ text?: string; message?: string; error?: string }>(
              `/api/context-packs/library/resolve-address?address=${encodeURIComponent(nameOrRef)}`,
            );
            if (res.status !== 200) {
              throw new Error(res.data?.message ?? res.data?.error ?? `后台服务对 resolve-address 返回 HTTP ${res.status}`);
            }
            if (opts.json) console.log(JSON.stringify(res.data, null, 2));
            else process.stdout.write(res.data.text ?? "");
            return;
          }
          if (exact.status === 400) throw new Error(exact.data?.message ?? `不安全的 context pack ref '${nameOrRef}'。`);
          if (exact.status !== 200) throw new Error(`后台服务对 /api/context-packs/library/by-ref 返回 HTTP ${exact.status}`);
          entry = exact.data;
        } else {
          entry = await resolvePack(client, nameOrRef);
        }
        const res = await client.get<PreviewWire>(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(entry.relativePath)}`);
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        const bundle = res.data;
        if (opts.json) {
          console.log(JSON.stringify(bundle, null, 2));
          return;
        }
        // 警告走 stderr，让 stdout 恰好是被服务的 bundle 字节。
        if (bundle.missingFiles.length > 0) {
          console.error(`警告：manifest 引用的 ${bundle.missingFiles.length} 个文件在磁盘上缺失。`);
          for (const m of bundle.missingFiles) console.error(`  - ${m.path}（role：${m.role}）`);
        }
        console.log(bundle.bundleText);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // OPR.0.5.3.5 Atom 4d——情境组合投递（profile 动词）。
  // 仅服务：片段连同其来源标签送到 stdout（Q2 修正案 1），
  // 预算报告 + 出处警告送 stderr。和每个库动词一样不投递——这里没有任何东西
  // 发到席位。命名 rig/seat（或 mission）是调用方对该目录子树读取权的显式授予。
  cmd.command("profile")
    .argument("<name-or-ref>", "context pack 名或路径式 ref（其 manifest 必须声明 atoms）")
    .requiredOption("--situation <situation>", "fresh | handover | post-compaction")
    // r1 4d obs 2：默认取自席位自身的环境——一个忘了带 flag 的 codex 席位
    // 绝不能静默拿到 claude profile（mini-req 3 是"各运行时组合出不同
    // profile"的规则）。flag 优先于 env；认不出的 env 值回退到 claude，
    // 而不是在 env 拥有者可能无法控制的表面上报错。
    .option("--runtime <runtime>", "claude-code（别名：claude）或 codex（默认：$OPENRIG_RUNTIME，否则 claude-code）", contextRuntimeArg)
    .option("--profile <profile>", "pack 声明的命名安装 profile（选择 + 有序阶段）")
    .option("--budget <tokens>", "情境 token 预算——超出只报告，绝不截断")
    .option("--rig <rig>", "配合 --seat：授予对该席位树的读取权（seat: atoms）")
    .option("--seat <seat>", "配合 --rig：其树可供 seat: atoms 读取的那个席位")
    .option("--mission <mission>", "授予对该 mission 树的读取权（mission: atoms）")
    .option("--slice <slice>", "配合 --mission：组合遗留的默认 project/mission/slice SPEC 遍历")
    .option("--json", "JSON 输出（完整组合出的 profile）")
    .action(async (nameOrRef: string, opts: { situation: string; runtime?: string; profile?: string; budget?: string; rig?: string; seat?: string; mission?: string; slice?: string; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrRef);
        // r1 F2：产品的运行时词表是 "claude-code" / "codex"
        //（适配器的取值，跑在真实席位上）——显式映射。一个真正未知的值
        // 会带着声音回退到 claude：未来的第三个运行时绝不能静默拿到
        // claude profile（这正是本默认要堵的 mini-req 3 隐患）。
        const envRuntime = process.env["OPENRIG_RUNTIME"];
        let runtime = opts.runtime;
        if (runtime === undefined) {
          if (envRuntime === "codex") runtime = "codex";
          else if (envRuntime === "claude-code" || envRuntime === "claude") runtime = "claude";
          else {
            if (envRuntime) console.error(`警告：无法识别的 OPENRIG_RUNTIME '${envRuntime}'——按 claude profile 组合；传 --runtime 覆盖。`);
            runtime = "claude";
          }
        }
        // 保持 composer/manifest key 与返回元数据兼容。
        if (runtime === "claude-code") runtime = "claude";
        const params = new URLSearchParams({ ref: entry.relativePath, situation: opts.situation, runtime });
        if (opts.profile !== undefined) params.set("profile", opts.profile);
        if (opts.budget !== undefined) params.set("budget", opts.budget);
        if (opts.rig !== undefined) params.set("rig", opts.rig);
        if (opts.seat !== undefined) params.set("seat", opts.seat);
        if (opts.mission !== undefined) params.set("mission", opts.mission);
        if (opts.slice !== undefined) params.set("slice", opts.slice);
        const res = await client.get<{
          profileId?: string;
          phases?: Array<{ id: string; kind: string; sources?: string[]; estimatedTokens: number }>;
          pieces?: Array<{ atomId: string; address: string; sourceKind: string; text: string; estimatedTokens: number }>;
          totalEstimatedTokens?: number;
          budget?: { limitTokens: number; overageTokens: number; dropCandidates: Array<{ atomId: string; priority: string; estimatedTokens: number }> };
          provenanceWarnings?: string[];
          message?: string;
          error?: string;
        }>(`/api/context-packs/library/by-ref/profile?${params.toString()}`);
        if (res.status !== 200) {
          throw new Error(res.data?.message ?? res.data?.error ?? `后台服务对 by-ref/profile 返回 HTTP ${res.status}`);
        }
        const profile = res.data;
        if (opts.json) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }
        if (profile.profileId) {
          console.error(`PROFILE ${profile.profileId}`);
          for (const phase of profile.phases ?? []) {
            const sources = phase.sources ? ` [${phase.sources.join(", ")}]` : "";
            console.error(`PHASE ${phase.id}（${phase.kind}${sources}，约 ${phase.estimatedTokens} tokens）`);
          }
        }
        // 警告与预算报告走 stderr，让 stdout 恰好是智能体消费的组合遍历。
        for (const w of profile.provenanceWarnings ?? []) console.error(`PROVENANCE ${w}`);
        if (profile.budget) {
          console.error(
            `预算：超出约 ${profile.budget.overageTokens} tokens（上限 ${profile.budget.limitTokens}）；` +
            `按顺序的可丢弃候选：${profile.budget.dropCandidates.map((d) => `${d.atomId}（${d.priority}，约 ${d.estimatedTokens}）`).join(", ")}`,
          );
        }
        for (const p of profile.pieces ?? []) {
          // r1 4d obs 1：转义标记骑在框架头上，所以一个丢弃了 stderr 的
          // 智能体仍能知道某个片段的字节来自它根之外——自描述负载，
          // 一个组合字节都不动。
          const escaped = (p as { provenance?: { escapesRoot?: boolean } }).provenance?.escapesRoot ? " !ESCAPED-ROOT" : "";
          console.log(`=== ${p.atomId} [${p.sourceKind}${escaped}] ${p.address}（约 ${p.estimatedTokens} tokens）`);
          console.log(p.text);
          console.log("");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // OPR.0.5.3.5 mini-req 7——离席者的边界写入（Q2 要求，单靠存储满足不了）。
  // 和 trace 一样不依赖后台服务：席位目录从 topology.root 配置解析；写入流经
  // 唯一的存储（取代 + 可寻址闸门）；契约发现走 stderr，而写入仍落地——
  // 边界绝不因文字形状而被阻塞。
  cmd.command("recap-write")
    .description("在交接边界写入本席位编写的 RECAP（带理由的决策）；把前一份 recap 取代进席位的链")
    .requiredOption("--rig <rig>", "Rig 名（rigs/<rig> 这一层）")
    .requiredOption("--seat <seat>", "Seat id（seats/<seat> 这一层）")
    .requiredOption("--file <path>", "包含 recap 内容的 Markdown 文件")
    .action(async (opts: { rig: string; seat: string; file: string }) => {
      try {
        const { writeSeatRecap, validateRecapContract, listRecapChain } = await import("@openrig/daemon/seat-recap-store");
        const content = readFileSync(opts.file, "utf-8");
        const store = new ConfigStore();
        const topologyRoot = String(store.resolveWithSource("topology.root").value);
        assertSafeTopologySegment("rig", opts.rig);
        assertSafeTopologySegment("seat", opts.seat);
        const rigDir = join(topologyRoot, "rigs", opts.rig);
        if (!existsSync(rigDir)) {
          throw new Error(`rig 目录 ${rigDir} 不存在——请对照拓扑树核对 --rig（topology.root=${topologyRoot}）。`);
        }
        const seatDir = join(topologyRoot, "rigs", opts.rig, "seats", opts.seat);
        assertDestinationNamespaceContained(join(topologyRoot, "rigs"), `${opts.rig}/seats/${opts.seat}/RECAP.md`);
        mkdirSync(seatDir, { recursive: true });
        for (const f of validateRecapContract(content)) {
          console.error(f.kind === "no-decisions-section"
            ? "ADVISORY no-decisions-section：编写契约要求带理由的决策——只有结论是有损交接形态。"
            : `ADVISORY nonstandard-unverified-marker（第 ${f.line} 行）：请用规范的 'UNVERIFIED:' 形式，让不确定的事实可被找到。`);
        }
        writeSeatRecap({ seatDir, content });
        const chain = listRecapChain(seatDir);
        console.log(`Recap 已写入：${join(seatDir, "RECAP.md")}${chain.length > 0 ? `（已保留 ${chain.length} 个被取代的前序）` : ""}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("sync")
    .description("重新遍历发现根并刷新库索引")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.post<{ count: number; errors: Array<{ source: string; error: string }>; entries: ContextPackEntryWire[] }>(
          "/api/context-packs/library/sync",
        );
        if (res.status !== 200) throw new Error(`后台服务返回 HTTP ${res.status}`);
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`已索引 ${data.count} 个 context pack。`);
        if (data.errors.length > 0) {
          console.log(`遇到 ${data.errors.length} 个解析错误：`);
          for (const e of data.errors) console.log(`  - ${e.source}：${e.error}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("add")
    .argument("<source>", "pack 目录/manifest URL，或带 --git 的 Git 仓库路径/URL")
    .description("安装一个 pack；--git 在 Git 仓库中发现 pack 并保留其更新关系")
    .option("--name <name>", "覆盖安装名（默认：manifest 名 / 源 basename）")
    .option("--git", "用已有 Git 凭证克隆一个 Git 仓库路径/URL；选择一个 pack 快照")
    .option("--checkout", "配合 --git，选择一个已有的 checkout 而非克隆；更新可在其中合并")
    .option("--pack <path>", "配合 --git，选一个仓库相对的 pack；默认发现 manifest.yaml 或 .openrig/context-packs")
    .option("--json", "JSON 输出")
    .action(async (source: string, opts: { name?: string; json?: boolean; git?: boolean; checkout?: boolean; pack?: string }) => {
      try {
        // OPR.0.5.9.5 Wave B——配置解析的 context 库，
        // 绝非常量写死的 ~/.openrig；后台服务解析同一个 key。
        const targetRoot = new ConfigStore().resolve().context.root;
        let targetDir: string;
        let gitSelection: ReturnType<typeof addGitContext>["selected"] | undefined;
        if ((opts.pack || opts.checkout) && !opts.git) throw new Error("--pack 与 --checkout 需要 --git。");
        if (opts.git) {
          const gitClient = await getClient();
          assertLocalGitClient(gitClient);
          ({ installedAt: targetDir, selected: gitSelection } = addGitContext(source, opts, targetRoot));
        } else if (isHttpUrl(source)) {
          // R4——URL 安装：抓取 → 校验 → 原子暂存+改名（无半成品 pack）。
          ({ targetDir } = await installPackFromUrl(source, opts.name, targetRoot));
        } else {
          // 本地目录安装。
          if (!existsSync(source)) throw new Error(`未找到源目录：${source}`);
          const stat = lstatSync(source);
          if (stat.isSymbolicLink()) throw new Error(`源不能是软链：${source}`);
          if (!stat.isDirectory()) throw new Error(`源必须是含 manifest.yaml 的目录：${source}`);
          const manifestPath = join(source, "manifest.yaml");
          if (!existsSync(manifestPath)) {
            throw new Error(`源目录必须包含 manifest.yaml：${source}`);
          }
          validateContextPackManifestForInstall(manifestPath);
          const installName = opts.name ?? (() => {
            try {
              const raw = readFileSync(manifestPath, "utf-8");
              const m = raw.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m);
              return m?.[1]?.trim() || basename(source);
            } catch {
              return basename(source);
            }
          })();
          assertSafeInstallRef(installName);
          assertTreeHasNoSymlinks(source);
          mkdirSync(targetRoot, { recursive: true });
          assertDestinationNamespaceContained(targetRoot, installName);
          targetDir = join(targetRoot, installName);
          let targetExists = false;
          try {
            lstatSync(targetDir);
            targetExists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          if (targetExists) {
            throw new Error(`名为 '${installName}' 的 context pack 已存在于 ${targetDir}。先移除它，或用 --name 装到别的名字下。`);
          }
          cpSync(source, targetDir, { recursive: true });
        }
        // 同步后台服务库，让新 pack 立刻可见。
        const client = await getClient();
        const syncRes = await client.post<{ count: number; errors?: Array<{ source: string; error: string }>; entries: ContextPackEntryWire[] }>("/api/context-packs/library/sync");
        if (syncRes.status !== 200) {
          // 安装成功；同步失败 → 仍展示安装路径。
          if (opts.json) console.log(JSON.stringify({ installedAt: targetDir, syncError: `HTTP ${syncRes.status}` }, null, 2));
          else console.log(`已安装到 ${targetDir}；后台服务同步失败（HTTP ${syncRes.status}）。手动运行 'zrig context sync'。`);
          return;
        }
        const syncError = syncRes.data.errors?.find((e) => e.source === targetDir);
        if (syncError) {
          throw new Error(`已安装到 ${targetDir}，但后台服务在同步时拒绝了该 pack：${syncError.error}`);
        }
        if (gitSelection && !syncRes.data.entries.some((entry) => resolve(entry.sourcePath) === resolve(targetDir))) {
          throw new Error(`Git 选择已保留在 ${targetDir}，但这个后台服务不服务它。使用前请检查 context.root 与 workspace ref 的优先级。`);
        }
        if (opts.json) {
          console.log(JSON.stringify({ installedAt: targetDir, count: syncRes.data.count, ...(gitSelection ? { gitSource: gitSelection } : {}) }, null, 2));
        } else {
          console.log(`已安装到 ${targetDir}。库现有 ${syncRes.data.count} 个 context pack。`);
          if (gitSelection) console.log(`Git ${gitSelection.revision}，来自 ${gitSelection.checkout}；用 rig context source 查看/更新。`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const source = cmd.command("source")
    .description("查看 Git checkout 与被服务 context 的差异，或显式抓取/合并并选择一次更新")
    .addHelpText("after", "\n开始：zrig context add <仓库路径或URL> --git [--pack path]\n在报告的 checkout 里用普通 Git 编辑/提交。更新绝不 push 或 reset。\n冲突会保留旧选择；重试前在 checkout 里解决/提交或中止。\n选择不证明智能体已消费；用 context get 并检查真实消费者。\n");
  for (const operation of ["inspect", "update"] as const) {
    source.command(operation)
      .argument("<ref>", "所选的 Git 后端 context pack ref")
      .description(operation === "inspect"
        ? "读取本地 revision、改动、冲突与选择；不 fetch、不主张已消费"
        : "显式 fetch/合并上游，然后选择干净的 pack；拒绝本地改动选择")
      .option("--json", "JSON 输出")
      .action(async (ref: string, opts: { json?: boolean }) => {
        try {
          const client = await getClient();
          assertLocalGitClient(client);
          const entry = await resolvePack(client, ref);
          const localRoot = new ConfigStore().resolve().context.root;
          if (resolve(entry.sourcePath) !== resolve(localRoot, entry.relativePath)) throw new Error("这个 pack 不在本地配置的 context 库里。请在它所属的 instance 上运行 Git 源命令。");
          if (entry.sourceType === "builtin") throw new Error("内置 context 不是可写的 Git 选择。");
          const result = operation === "inspect" ? inspectGitContext(entry.sourcePath) : updateGitContext(entry.sourcePath);
          if (operation === "update") {
            const sync = await client.post<{ errors?: Array<{ source: string; error: string }>; entries: ContextPackEntryWire[] }>("/api/context-packs/library/sync");
            if (sync.status !== 200) throw new Error(`选择已更新，但库同步失败（HTTP ${sync.status}）；运行 zrig context sync。`);
            if (!sync.data.entries.some((candidate) => resolve(candidate.sourcePath) === resolve(entry.sourcePath))) throw new Error(`选择已保留，但后台服务无法服务它：${sync.data.errors?.map((error) => error.error).join("; ") || "检查 context root 与 ref 优先级"}`);
          }
          // 结构化输出在终端与机器使用中都把 checkout/所选字节/消费区分开，
          // 无需第二个状态渲染器。
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          const message = (err as Error).message;
          console.error(opts.json ? JSON.stringify({ error: message }) : message);
          process.exitCode = 1;
        }
      });
  }

  cmd.command("rm")
    .argument("<ref>", "要移除的 context pack 的路径式 ref（例如 packs/compaction-restore）")
    .description("按路径式 ref 从库中移除一个 context pack")
    .option("--json", "JSON 输出")
    .action(async (ref: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.delete<{
          removed?: boolean;
          ref?: string;
          removedPath?: string;
          count?: number;
          error?: string;
          message?: string;
        }>(`/api/context-packs/library/by-ref?ref=${encodeURIComponent(ref)}`);
        if (res.status !== 200) {
          throw new Error(res.data?.message ?? res.data?.error ?? `后台服务返回 HTTP ${res.status}`);
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        console.log(`已移除 context pack '${res.data.ref}'。${typeof res.data.count === "number" ? ` 库现有 ${res.data.count} 个 context pack。` : ""}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
