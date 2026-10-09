// 工作组上下文 / 可组合上下文注入 v0（PL-014）——库服务。
//
// 遍历已配置的发现根，解析每个 pack 的 manifest.yaml，并产出可供后台服务 HTTP 路由、
// UI 库和发送机制使用的 ContextPackEntry。工作区表面对账遵循：操作人员的文件系统编辑
// 总会在下次 scan() 时胜出，这与 PL-004 Phase D 对 workflow_specs 的契约一致。

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { assemblePlainFiles, type PlainFileAssembly } from "./bundle-assembler.js";
import { assertSafePackRef } from "./ref-safety.js";
import { parseManifest } from "./manifest-parser.js";
import { estimateTokensFromBytes } from "./token-estimate.js";
import {
  ContextPackError,
  type ContextPackEntry,
  type ContextPackEntryFile,
  type ContextPackSourceType,
} from "./context-pack-types.js";

export interface ContextPackLibraryRoot {
  /** 发现根的绝对路径。Slice-03 Atom 2：任何包含 manifest.yaml 的嵌套目录都是 pack；
   *  其 ref 是从该根出发的相对路径（规格第 2 节的路径式 ref，例如
   *  如 `packs/compaction-restore`）。 */
  path: string;
  sourceType: ContextPackSourceType;
}

export interface ContextPackLibraryOpts {
  roots: ContextPackLibraryRoot[];
  /** Atom 3 写入失败后清理契约的窄测试接缝。 */
  writeFile?: (path: string, data: string | Buffer) => void;
}

export interface ComposeContextPackSource {
  /** 由本地 CLI 调用方解析的绝对源路径。 */
  path: string;
  /** 作为 YAML 序列化出处保留的调用方原始写法。 */
  label: string;
}

export interface ComposeContextPackResult extends PlainFileAssembly {
  ref: string;
  entry: ContextPackEntry;
}

/** 稳定不透明 id = `context-pack:<ref>`（Slice-03 Atom 5）。路径式 ref 本身就是身份，
 *  因而每个 pack 的 id 唯一；即使两个 ref 共享 manifest 的 name+version 也不再冲突。
 *  同时保留 UI library-review 派发所依赖的 `context-pack:` 前缀。旧索引移除时，
 *  冒号 id 的 name:version 寻址/解析也已删除；现在只按 ref 解析。 */
export function contextPackId(ref: string): string {
  return `context-pack:${ref}`;
}

export { estimateTokensFromBytes } from "./token-estimate.js";

export class ContextPackLibraryService {
  /** Slice-03 Atom 2（守卫修正 b74e4576）：主索引。归一化后的安全路径式 ref
   *  就是 pack 身份（规格第 2 节“ref 即契约”）。getByRef/list/scan().count 都观测
   *  此 Map；跨根出现同一 ref 时后根胜出，使优先级处处一致（一行、一个计数、一次解析）。
   *  manifest name/version 相同但 ref 不同的条目在构造上彼此独立。 */
  private entriesByRef = new Map<string, ContextPackEntry>();
  private readonly roots: ContextPackLibraryRoot[];
  private readonly writeFile: (path: string, data: string | Buffer) => void;

  constructor(opts: ContextPackLibraryOpts) {
    this.roots = opts.roots;
    this.writeFile = opts.writeFile ?? ((path, data) => writeFileSync(path, data));
  }

  /** Slice-03 Atom 2——递归路径寻址发现：遍历根目录，返回每个包含 manifest.yaml
   *  的嵌套目录及其路径式 ref。pack 是叶子：带 manifest 的目录子树属于该 pack，
   *  所以发现过程不再下钻；嵌套 manifest 会使外层 pack 文件产生歧义。永不遍历
   *  符号链接目录（dirent.isDirectory() 采用 lstat 语义，即 Atom-2 前语义并延续到递归）。 */
  private discoverPackDirs(rootPath: string): Array<{ packDir: string; ref: string }> {
    const found: Array<{ packDir: string; ref: string }> = [];
    const walk = (dir: string): void => {
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const child = join(dir, dirent.name);
        if (existsSync(join(child, "manifest.yaml"))) {
          found.push({ packDir: child, ref: relative(rootPath, child).split(sep).join("/") });
        } else {
          walk(child);
        }
      }
    };
    if (existsSync(rootPath)) walk(rootPath);
    return found;
  }

  /** 重新遍历所有根，替换内存索引并返回计数。 */
  scan(): { count: number; errors: Array<{ source: string; error: string }> } {
    const nextByRef = new Map<string, ContextPackEntry>();
    const claimedPackDirs = new Set<string>();
    const errors: Array<{ source: string; error: string }> = [];

    for (const root of this.roots) {
      for (const { packDir, ref } of this.discoverPackDirs(root.path)) {
        // 重叠根共享一个地址空间。每个物理 pack 归首个配置根所有，
        // 因而嵌套根不能给它第二个 ref，也不能遮蔽已使用该 ref 的另一 pack。
        const physicalPackDir = resolve(packDir);
        if (claimedPackDirs.has(physicalPackDir)) continue;
        claimedPackDirs.add(physicalPackDir);
        // 发现信任边界（Atom 2）：每个发现的 ref 都通过封闭的逐段契约；
        // 不安全的磁盘 ref 形成结构化、失败可见错误并跳过该 pack，绝不入索引。
        try {
          assertSafePackRef(ref);
        } catch (err) {
          errors.push({ source: packDir, error: (err as Error).message });
          continue;
        }
        try {
          const entry = this.readPackEntry(packDir, join(packDir, "manifest.yaml"), root, ref);
          // 主身份 = ref。跨根同 ref 时后根胜出（启动配置的发现顺序为
          // workspace > user_file > builtin），所以 list/count/resolve 一致。
          // 无论 manifest 如何声明，不同 ref 都不会冲突。
          nextByRef.set(ref, entry);
        } catch (err) {
          errors.push({
            source: packDir,
            error: err instanceof ContextPackError
              ? `${err.code}: ${err.message}`
              : (err as Error).message,
          });
        }
      }
    }
    this.entriesByRef = nextByRef;
    return { count: nextByRef.size, errors };
  }

  /** Slice-03 Atom 2——解析信任边界：按路径式 ref 获取 pack。任何查找前，
   *  不安全 ref 就会形成结构化、失败可见错误；安全但不存在的 ref 如实返回 null。 */
  getByRef(ref: string): ContextPackEntry | null {
    try {
      assertSafePackRef(ref);
    } catch (err) {
      throw new ContextPackError("unsafe_ref", (err as Error).message, { ref });
    }
    return this.entriesByRef.get(ref) ?? null;
  }

  /** Slice-03 Atom 4——删除信任边界：按路径式 ref 移除 pack。安全顺序与
   *  getByRef/compose 一致：任何文件系统操作前，不安全 ref 就形成结构化、失败可见错误；
   *  安全但不存在的 ref 如实返回 pack_not_found；随包交付的 `builtin` pack 被拒绝。
   *  rm 镜像 add 的“操作人员可写”契约：add 只写 user_file 根，rm 绝不 rmSync
   *  package 目录下的随包资产。成功时删除 pack 目录，再次扫描使 ref 不再可解析。 */
  removeByRef(ref: string): { removed: boolean; ref: string; removedPath: string } {
    try {
      assertSafePackRef(ref);
    } catch (err) {
      throw new ContextPackError("unsafe_ref", (err as Error).message, { ref });
    }
    const entry = this.entriesByRef.get(ref);
    if (!entry) {
      throw new ContextPackError("pack_not_found", `库中未找到 context pack ref '${ref}'`, { ref });
    }
    if (entry.sourceType === "builtin") {
      throw new ContextPackError(
        "pack_not_removable",
        `context pack ref '${ref}' 是随包交付的 builtin pack，不能移除`,
        { ref, sourceType: entry.sourceType },
      );
    }
    const removedPath = entry.sourcePath;
    rmSync(removedPath, { recursive: true, force: true });
    this.scan();
    return { removed: true, ref, removedPath };
  }

  list(): ContextPackEntry[] {
    // 主 ref 索引视图：每个 ref 一行；manifest name/version 相同时以 ref 确定性决胜。
    return Array.from(this.entriesByRef.values()).sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.relativePath.localeCompare(b.relativePath),
    );
  }


  /**
   * Atom 3：把具名文件组合成一个持久路径式 ref pack。
   *
   * 安全顺序不可打乱：先校验 ref；在首次修改前拒绝所有已存在、隐藏或不安全的命名空间，
   * 并预检每个来源。先写成员、最后写 manifest.yaml，使发现过程绝不会观察到半成品 pack。
   * 写入失败时删除新目标。
   */
  composeFromFiles(opts: {
    outRef: string;
    sources: ComposeContextPackSource[];
  }): ComposeContextPackResult {
    // 首个信任边界操作：封闭的 Atom-1 校验器。
    try {
      assertSafePackRef(opts.outRef);
    } catch (err) {
      throw new ContextPackError("unsafe_ref", (err as Error).message, { ref: opts.outRef });
    }

    if (opts.sources.length === 0) {
      throw new ContextPackError(
        "missing_files",
        "context 组合至少需要一个 --from 文件",
        { missingFiles: [] },
      );
    }

    // 完整来源预检必须先于任何输出/存储冲突检查。
    const missingFiles = opts.sources
      .filter((source) => !existsSync(source.path))
      .map((source) => source.path);
    if (missingFiles.length > 0) {
      throw new ContextPackError(
        "missing_files",
        `找不到 context 组合源文件：${missingFiles.join(", ")}`,
        { missingFiles },
      );
    }

    const allowedSuffixes = new Set([".md", ".markdown", ".yaml", ".yml", ".txt"]);
    const members = opts.sources.map((source, index) => {
      let content: Buffer;
      try {
        if (!statSync(source.path).isFile()) throw new Error("来源不是普通文件");
        content = readFileSync(source.path);
      } catch (err) {
        throw new ContextPackError(
          "file_read_failed",
          `读取组合来源 ${source.path} 失败：${(err as Error).message}`,
          { path: source.path },
        );
      }
      const candidateSuffix = extname(source.label).toLowerCase();
      const suffix = allowedSuffixes.has(candidateSuffix) ? candidateSuffix : ".txt";
      return {
        path: `source-${String(index + 1).padStart(4, "0")}${suffix}`,
        label: source.label,
        content,
      };
    });

    const writeRoot = this.roots.find((root) => root.sourceType === "user_file");
    if (!writeRoot) {
      throw new ContextPackError(
        "store_unavailable",
        "context pack 组合需要可写的 user_file 存储根",
      );
    }

    // 检查前先刷新，使完全相同的 ref 在任意根中都会被拒绝，而不只是在用户目标路径上；
    // 这保持 Atom-2 的优先级真相。
    this.scan();
    if (this.entriesByRef.has(opts.outRef)) {
      throw new ContextPackError(
        "pack_exists",
        `context pack ref '${opts.outRef}' 已存在于库中`,
        { ref: opts.outRef },
      );
    }

    const segments = opts.outRef.split("/");
    const targetDir = join(writeRoot.path, ...segments);
    // lstat 也能看见悬空符号链接；任何实际存在的精确目标都是冲突，绝不覆盖或合并。
    try {
      lstatSync(targetDir);
      throw new ContextPackError(
        "pack_exists",
        `context pack 目标 '${targetDir}' 已存在`,
        { ref: opts.outRef, targetDir },
      );
    } catch (err) {
      if (err instanceof ContextPackError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTDIR 表示某个祖先是文件；下方命名空间遍历会把它转换为
      // 结构化 unsafe_ref_namespace 契约。
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }

    // Atom-2 把带 manifest 的目录视为叶子。拒绝无法发现的子项，并在 mkdir
    // 可能沿路径进入前拒绝符号链接或非目录命名空间段。
    let cursor = writeRoot.path;
    for (const segment of segments.slice(0, -1)) {
      cursor = join(cursor, segment);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(cursor);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ContextPackError(
          "unsafe_ref_namespace",
          `context pack ref '${opts.outRef}' 穿过符号链接或非目录命名空间段 '${cursor}'`,
          { ref: opts.outRef, segmentPath: cursor },
        );
      }
      if (existsSync(join(cursor, "manifest.yaml"))) {
        throw new ContextPackError(
          "pack_ref_below_pack",
          `context pack ref '${opts.outRef}' 位于已有 pack 叶子 '${cursor}' 下`,
          { ref: opts.outRef, ancestor: cursor },
        );
      }
    }

    const name = segments.at(-1)!;
    // OPR.0.5.6.10——compose 固定盖入 `mission` 类别（qitem-20260828092429-d2f94323
    // 的桌面裁决：当前所有 compose 消费者均如此；调用方提供 taxonomy 延迟到 slice 08，
    // 届时第二个消费者才证明该选项应存在）。输出必须满足本服务扫描所用的解析器，
    // 否则 compose 会拒绝自己的输出。
    const manifest = stringifyYaml({
      name,
      version: "1",
      purpose: `由 ${members.length} 个有序文件组合而成`,
      taxonomy: "mission",
      files: members.map((member) => ({
        path: member.path,
        role: "source",
        summary: member.label,
      })),
    });

    let createdTarget = false;
    try {
      mkdirSync(dirname(targetDir), { recursive: true });
      try {
        mkdirSync(targetDir);
        createdTarget = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ContextPackError(
            "pack_exists",
            `context pack 目标 '${targetDir}' 已存在`,
            { ref: opts.outRef, targetDir },
          );
        }
        throw err;
      }
      for (const member of members) {
        this.writeFile(join(targetDir, member.path), member.content);
      }
      // 最后写 manifest：只有完整 pack 才能被发现。
      this.writeFile(join(targetDir, "manifest.yaml"), manifest);
    } catch (err) {
      if (createdTarget) rmSync(targetDir, { recursive: true, force: true });
      if (err instanceof ContextPackError) throw err;
      throw new ContextPackError(
        "pack_write_failed",
        `写入 context pack '${opts.outRef}' 失败：${(err as Error).message}`,
        { ref: opts.outRef, targetDir },
      );
    }

    this.scan();
    const entry = this.entriesByRef.get(opts.outRef);
    if (!entry || entry.sourcePath !== targetDir) {
      rmSync(targetDir, { recursive: true, force: true });
      this.scan();
      throw new ContextPackError(
        "pack_write_failed",
        `组合后的 context pack '${opts.outRef}' 无法通过其持久 ref 被发现`,
        { ref: opts.outRef, targetDir },
      );
    }

    const assembled = assemblePlainFiles({
      files: members.map((member) => ({
        path: member.path,
        content: member.content.toString("utf-8"),
      })),
    });
    return { ref: opts.outRef, entry, ...assembled };
  }

  /** 解析 pack 条目文件的绝对路径，并执行 containment 检查，
   *  防止路径遍历逃出 pack 目录。 */
  resolveFileWithinPack(packEntry: ContextPackEntry, relPath: string): string {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new ContextPackError(
        "file_outside_pack",
        `相对路径 '${relPath}' 必须位于 pack 目录内（不得含 '..'，不得以 '/' 开头）`,
        { packId: packEntry.id, relPath },
      );
    }
    const abs = join(packEntry.sourcePath, relPath);
    if (!abs.startsWith(packEntry.sourcePath + "/") && abs !== packEntry.sourcePath) {
      throw new ContextPackError(
        "file_outside_pack",
        `解析后的路径 '${abs}' 位于 pack '${packEntry.sourcePath}' 之外`,
        { packId: packEntry.id, relPath, resolved: abs },
      );
    }
    return abs;
  }

  private readPackEntry(
    packDir: string,
    manifestPath: string,
    root: ContextPackLibraryRoot,
    ref: string,
  ): ContextPackEntry {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = parseManifest(raw, manifestPath);

    let mostRecentMtime = 0;
    try {
      mostRecentMtime = statSync(manifestPath).mtimeMs;
    } catch { /* manifest stat 不可读时回退为 0 */ }

    const files: ContextPackEntryFile[] = manifest.files.map((mf) => {
      const abs = join(packDir, mf.path);
      let bytes: number | null = null;
      let mtime = 0;
      try {
        const st = statSync(abs);
        bytes = st.size;
        mtime = st.mtimeMs;
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

    return {
      // id 与 relativePath 共享唯一真相来源：已发现的路径式 ref（POSIX 连接）。
      // id 为 `context-pack:<ref>`，不透明且唯一。
      id: contextPackId(ref),
      kind: "context-pack",
      name: manifest.name,
      version: manifest.version,
      purpose: manifest.purpose ?? null,
      taxonomy: manifest.taxonomy,
      sourceType: root.sourceType,
      sourcePath: packDir,
      relativePath: ref,
      updatedAt: new Date(mostRecentMtime || Date.now()).toISOString(),
      manifestEstimatedTokens: typeof manifest.estimatedTokens === "number" ? manifest.estimatedTokens : null,
      derivedEstimatedTokens,
      files,
    };
  }
}
