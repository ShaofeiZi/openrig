// 分叉原语 + Starter 智能体镜像 v0（PL-016）——资料库服务。
//
// 遍历 discovery root，解析每个 image 的 manifest.yaml + stats.json，并为后台服务 HTTP route、
// UI library 和 CLI 动词族生成 AgentImageEntry 记录。结构与 ContextPackLibraryService（PL-014）
// 对应，但有以下差异：
//   - sourceResumeToken 会传给 consumer（instantiator 使用它；面向操作员的 surface 会将其遮蔽）
//   - stats.json 是单独的可变文件，在 fork-count 增加时原子更新
//   - .pinned sentinel 文件可防止 image 被 prune
//
// 存储以文件系统为 canonical：~/.openrig/agent-images/<name>/ 加 workspace 本地
// .openrig/agent-images/<name>/。不新增 SQLite 表。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseAgentImageManifest } from "./manifest-parser.js";
import {
  AgentImageError,
  type AgentImageEntry,
  type AgentImageEntryFile,
  type AgentImageManifest,
  type AgentImageSourceType,
  type AgentImageStats,
} from "./agent-image-types.js";

export interface AgentImageLibraryRoot {
  /** 直接子项为 image 目录的绝对路径。 */
  path: string;
  sourceType: AgentImageSourceType;
}

export interface AgentImageLibraryOpts {
  roots: AgentImageLibraryRoot[];
}

/** 稳定 id 格式：agent-image:<name>:<version>（与 context-pack: 并行）。 */
export function agentImageId(name: string, version: string): string {
  return `agent-image:${name}:${version}`;
}

export function parseAgentImageId(id: string): { name: string; version: string } | null {
  if (!id.startsWith("agent-image:")) return null;
  const rest = id.slice("agent-image:".length);
  const last = rest.lastIndexOf(":");
  if (last === -1) return null;
  return { name: rest.slice(0, last), version: rest.slice(last + 1) };
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

const PINNED_SENTINEL = ".pinned";
const STATS_FILENAME = "stats.json";

const DEFAULT_STATS: AgentImageStats = {
  forkCount: 0,
  lastUsedAt: null,
  estimatedSizeBytes: 0,
  lineage: [],
};

export class AgentImageLibraryService {
  private entries = new Map<string, AgentImageEntry>();
  private readonly roots: AgentImageLibraryRoot[];

  constructor(opts: AgentImageLibraryOpts) {
    this.roots = opts.roots;
  }

  getRoots(): readonly AgentImageLibraryRoot[] {
    return this.roots;
  }

  scan(): { count: number; errors: Array<{ source: string; error: string }> } {
    const next = new Map<string, AgentImageEntry>();
    const errors: Array<{ source: string; error: string }> = [];
    for (const root of this.roots) {
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = existsSync(root.path)
          ? readdirSync(root.path, { withFileTypes: true })
          : [];
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const imageDir = join(root.path, dirent.name);
        const manifestPath = join(imageDir, "manifest.yaml");
        if (!existsSync(manifestPath)) continue;
        try {
          const entry = this.readImageEntry(imageDir, manifestPath, root);
          // 冲突时后者优先（按启动时配置的发现顺序：workspace > user_file > builtin）。
          next.set(entry.id, entry);
        } catch (err) {
          errors.push({
            source: imageDir,
            error: err instanceof AgentImageError ? `${err.code}: ${err.message}` : (err as Error).message,
          });
        }
      }
    }
    this.entries = next;
    return { count: next.size, errors };
  }

  list(): AgentImageEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
  }

  get(id: string): AgentImageEntry | null {
    return this.entries.get(id) ?? null;
  }

  getByNameVersion(name: string, version: string): AgentImageEntry | null {
    return this.entries.get(agentImageId(name, version)) ?? null;
  }

  /**
   * 原子更新 stats.json——总是更新 lastUsedAt；仅在 `incrementForkCount: true` 时增加 forkCount
   *（默认为 true，以兼容首个已发布签名）。instantiator 分两阶段使用：
   *   1. 启动前（incrementForkCount: false）：记录操作员消费 image 的意图。更新 lastUsedAt，
   *      使 library view 即使在启动最终失败时也显示近期活动；操作员可看到“已尝试此 image”，
   *      而不会把尝试与成功 fork 混为一谈。
   *   2. 成功启动后（incrementForkCount: true）：仅在 startupResult.ok===true 时增加 forkCount。
   *      旧行为不论结果都会在产生意图时增加，从而用启动失败噪声污染 forkCount。
   *
   * Best-effort：统计写入失败会显示为 AgentImageError，但不会中止 consumer（image 消费路径本身
   * 不依赖 stats；操作员只会失去本次消费的 fork-count 可见性）。
   *
   * 向后兼容：旧版 `recordConsumption(id, () => new Date())` 形式仍有效；位置函数参数视为 `now`
   * 时钟，并使用 `incrementForkCount: true`。
   */
  recordConsumption(
    id: string,
    optsOrNow?: { incrementForkCount?: boolean; now?: () => Date } | (() => Date),
  ): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new AgentImageError("image_not_found", `library 中找不到 agent image '${id}'`);
    }
    const opts = typeof optsOrNow === "function"
      ? { incrementForkCount: true, now: optsOrNow }
      : { incrementForkCount: optsOrNow?.incrementForkCount ?? true, now: optsOrNow?.now ?? (() => new Date()) };
    const statsPath = join(entry.sourcePath, STATS_FILENAME);
    let current: AgentImageStats = { ...entry.stats };
    try {
      if (existsSync(statsPath)) {
        const raw = readFileSync(statsPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<AgentImageStats>;
        current = { ...current, ...parsed };
      }
    } catch {
      // stats.json 畸形——继续使用内存副本。
    }
    const next: AgentImageStats = {
      forkCount: (current.forkCount ?? 0) + (opts.incrementForkCount ? 1 : 0),
      lastUsedAt: opts.now().toISOString(),
      estimatedSizeBytes: current.estimatedSizeBytes ?? entry.stats.estimatedSizeBytes,
      lineage: current.lineage ?? entry.stats.lineage,
    };
    try {
      writeFileSync(statsPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
    } catch (err) {
      throw new AgentImageError(
        "stats_write_failed",
        `更新 ${id} 的 stats.json 失败：${(err as Error).message}`,
        { id, statsPath },
      );
    }
    // 将新 stats 镜像到内存 entry，使后续读取无需重新遍历文件系统即可看到增加后的 fork-count。
    entry.stats = next;
  }

  /** 固定 image——在 image 目录内创建 `.pinned` sentinel 文件。 */
  pin(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new AgentImageError("image_not_found", `找不到 agent image '${id}'`);
    const sentinelPath = join(entry.sourcePath, PINNED_SENTINEL);
    writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf-8");
    entry.pinned = true;
  }

  /** 取消固定——删除 `.pinned` sentinel。 */
  unpin(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new AgentImageError("image_not_found", `找不到 agent image '${id}'`);
    const sentinelPath = join(entry.sourcePath, PINNED_SENTINEL);
    try {
      unlinkSync(sentinelPath);
    } catch {
      // 已缺失——no-op。
    }
    entry.pinned = false;
  }

  private readImageEntry(
    imageDir: string,
    manifestPath: string,
    root: AgentImageLibraryRoot,
  ): AgentImageEntry {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseAgentImageManifest(raw, manifestPath);

    let mostRecentMtime = 0;
    let totalBytes = 0;
    try {
      const st = statSync(manifestPath);
      mostRecentMtime = st.mtimeMs;
      totalBytes += st.size;
    } catch { /* 不可读——继续处理。 */ }

    const files: AgentImageEntryFile[] = manifest.files.map((mf) => {
      const abs = join(imageDir, mf.path);
      let bytes: number | null = null;
      let mtime = 0;
      try {
        const st = statSync(abs);
        bytes = st.size;
        mtime = st.mtimeMs;
        totalBytes += bytes;
      } catch {
        bytes = null;
      }
      if (mtime > mostRecentMtime) mostRecentMtime = mtime;
      return {
        path: mf.path,
        role: mf.role,
        summary: mf.summary ?? null,
        absolutePath: bytes === null ? null : abs,
        bytes,
        estimatedTokens: bytes === null ? null : estimateTokensFromBytes(bytes),
      };
    });
    const derivedEstimatedTokens = files.reduce((acc, f) => acc + (f.estimatedTokens ?? 0), 0);

    // 若存在则读取 stats.json，否则使用空 stats。
    const statsPath = join(imageDir, STATS_FILENAME);
    let stats: AgentImageStats = { ...DEFAULT_STATS };
    if (existsSync(statsPath)) {
      try {
        const statRaw = readFileSync(statsPath, "utf-8");
        const parsed = JSON.parse(statRaw) as Partial<AgentImageStats>;
        stats = {
          forkCount: typeof parsed.forkCount === "number" ? parsed.forkCount : 0,
          lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : null,
          estimatedSizeBytes: typeof parsed.estimatedSizeBytes === "number" ? parsed.estimatedSizeBytes : totalBytes,
          lineage: Array.isArray(parsed.lineage) ? parsed.lineage.filter((l): l is string => typeof l === "string") : [],
        };
        const statStat = statSync(statsPath).mtimeMs;
        if (statStat > mostRecentMtime) mostRecentMtime = statStat;
      } catch {
        // stats 畸形——显示零值；后台服务会在下次消费时刷新覆盖。
      }
    }
    if (stats.estimatedSizeBytes === 0) stats.estimatedSizeBytes = totalBytes;
    if (stats.lineage.length === 0 && manifest.lineage) stats.lineage = [...manifest.lineage];

    const pinned = existsSync(join(imageDir, PINNED_SENTINEL));

    return {
      id: agentImageId(manifest.name, manifest.version),
      kind: "agent-image",
      name: manifest.name,
      version: manifest.version,
      runtime: manifest.runtime,
      sourceSeat: manifest.sourceSeat,
      sourceSessionId: manifest.sourceSessionId,
      sourceResumeToken: manifest.sourceResumeToken,
      // 原样显示 manifest 中的 sourceCwd。早于 source_cwd 支持的 manifest 返回 null（向后兼容）。
      sourceCwd: manifest.sourceCwd ?? null,
      notes: manifest.notes ?? null,
      createdAt: manifest.createdAt,
      sourceType: root.sourceType,
      sourcePath: imageDir,
      relativePath: relative(root.path, imageDir) || ".",
      updatedAt: new Date(mostRecentMtime || Date.now()).toISOString(),
      manifestEstimatedTokens: typeof manifest.estimatedTokens === "number" ? manifest.estimatedTokens : null,
      derivedEstimatedTokens,
      files,
      stats,
      lineage: stats.lineage,
      pinned,
    };
  }

  /** 向新 image 目录写入新 manifest、空 stats.json 和 cwd-deltas（若有）。 */
  install(
    targetRootPath: string,
    manifest: AgentImageManifest,
    fileContents: Map<string, string>,
  ): string {
    const targetDir = join(targetRootPath, manifest.name);
    if (existsSync(targetDir)) {
      throw new AgentImageError(
        "image_referenced",
        `${targetDir} 已存在 agent image 目录；请选择其他名称或移除现有目录`,
        { name: manifest.name, targetDir },
      );
    }
    mkdirSync(targetDir, { recursive: true });
    // 以 YAML 输出 manifest——将 camelCase key 映射为 snake_case，以便向前兼容操作员手工编辑。
    const yamlLines = [
      `name: ${manifest.name}`,
      `version: ${manifest.version}`,
      `runtime: ${manifest.runtime}`,
      `source_seat: ${quoteIfNeeded(manifest.sourceSeat)}`,
      `source_session_id: ${quoteIfNeeded(manifest.sourceSessionId)}`,
      `source_resume_token: ${quoteIfNeeded(manifest.sourceResumeToken)}`,
      `created_at: ${quoteIfNeeded(manifest.createdAt)}`,
    ];
    // 将 sourceCwd 持久化到 manifest YAML，使 Use-as-starter 片段可从 library entry 输出
    // `cwd: <source_cwd>`。捕获时 cwd 未知则省略。
    if (manifest.sourceCwd) {
      yamlLines.push(`source_cwd: ${quoteIfNeeded(manifest.sourceCwd)}`);
    }
    if (manifest.notes) {
      yamlLines.push(`notes: |`);
      for (const line of manifest.notes.split("\n")) yamlLines.push(`  ${line}`);
    }
    if (typeof manifest.estimatedTokens === "number") yamlLines.push(`estimated_tokens: ${manifest.estimatedTokens}`);
    if (manifest.lineage && manifest.lineage.length > 0) {
      yamlLines.push("lineage:");
      for (const l of manifest.lineage) yamlLines.push(`  - ${quoteIfNeeded(l)}`);
    }
    yamlLines.push("files:");
    for (const f of manifest.files) {
      yamlLines.push(`  - path: ${quoteIfNeeded(f.path)}`);
      yamlLines.push(`    role: ${quoteIfNeeded(f.role)}`);
      if (f.summary) yamlLines.push(`    summary: ${quoteIfNeeded(f.summary)}`);
    }
    writeFileSync(join(targetDir, "manifest.yaml"), yamlLines.join("\n") + "\n", "utf-8");
    // 空 stats——fork count 从 0 开始；lineage 来自 manifest。
    const stats: AgentImageStats = {
      forkCount: 0,
      lastUsedAt: null,
      estimatedSizeBytes: 0,
      lineage: manifest.lineage ? [...manifest.lineage] : [],
    };
    writeFileSync(join(targetDir, STATS_FILENAME), JSON.stringify(stats, null, 2) + "\n", "utf-8");
    for (const [relPath, content] of fileContents) {
      if (relPath.includes("..") || relPath.startsWith("/")) {
        throw new AgentImageError(
          "manifest_invalid",
          `安装文件路径 '${relPath}' 必须是 image 内的相对路径（不能含 '..'，不能以 '/' 开头）`,
        );
      }
      const abs = join(targetDir, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    return targetDir;
  }
}

function quoteIfNeeded(s: string): string {
  if (s === "" || /[:#\n@\\\s]/.test(s) || /^[!&*<>%`?,|\[\]{}'"]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}
