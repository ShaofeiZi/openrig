// PluginVendorService——plugin tree 的 vendoring + auto-fetch。
//
// 依据 plugin-primitive 第 3a 阶段 slice 3.2（IMPL-PRD §2.5 + DESIGN.md §5.5）。
//
// 职责：
//   1. ensureVendored(name)：目标缺失时，将 packages/daemon/assets/plugins/<name>/ 播种到
//      ~/.openrig/plugins/<name>/；清单版本较旧时推进版本。版本相同或更新的已安装字节保有权威性。
//   2. attemptAutoFetch(name)：尝试从 github.com/mvschwarz/openrig-plugins 获取最新版。
//      按 2026-05-10 编排指示，对 404、网络错误和超时静默容忍，始终以随包版本兜底；
//      同时记录结果供操作人员观测。
//   3. ensureLatest(name)：先解析本地随包/已安装版本的权威性，再尝试自动获取；获取失败时
//      保留本地副本。
//
// 设计说明：
//   - 所有 fs op + httpClient 均可注入（无需真实 filesystem 或 network 即可测试）。
//   - 按 IMPL-PRD §2.5 使用 5 秒 network timeout。
//   - 根据 founder 在 2026-05-10 的授权，github.com/mvschwarz/openrig-plugins 当前为空
//     （只有 LICENSE）；在另行授权发布前，404 是预期的正常状态 response。

import nodePath from "node:path";
import { createHash } from "node:crypto";

export interface PluginVendorFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles(dir: string): string[];
  rmrf?(path: string): void;
  /** source file permission bit（用于保留 mode 的 vendor staging）。可选：缺失时 no-op。 */
  statMode?(path: string): number;
  /** 将 permission bit 应用于文件（用于保留 mode 的 vendor staging）。可选：缺失时 no-op。 */
  chmod?(path: string, mode: number): void;
}

export interface HttpClientResponse {
  ok: boolean;
  status: number;
  /** 由 caller 解析的 body——v0 不使用，因为 fetch failure 是预期正常状态。未来 tarball extraction
   *  会使用它。 */
  body?: unknown;
}

export type HttpClient = (url: string, opts?: { timeoutMs?: number }) => Promise<HttpClientResponse>;

export interface PluginVendorServiceDeps {
  vendoredAssetsDir: string;
  userPluginsDir: string;
  fs: PluginVendorFs;
  httpClient: HttpClient;
  logger?: (...args: unknown[]) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const REPO_BASE = "https://github.com/mvschwarz/openrig-plugins";
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] as const;
const GLOBAL_VENDOR_VERSION = ".openrig-vendor-version";

function parseNumericVersion(raw: string, source: string): number[] {
  const value = raw.trim();
  if (!/^\d+(?:\.\d+){2}$/.test(value)) {
    throw new Error(`[plugin-vendor] ${source} 中的 version '${value}' 无效；应为数字 x.y.z authority`);
  }
  return value.split(".").map(Number);
}

function compareVersions(a: string, b: string): number {
  const left = parseNumericVersion(a, "source version");
  const right = parseNumericVersion(b, "target version");
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

export class PluginVendorService {
  private vendoredAssetsDir: string;
  private userPluginsDir: string;
  private fs: PluginVendorFs;
  private httpClient: HttpClient;
  private logger: (...args: unknown[]) => void;

  constructor(deps: PluginVendorServiceDeps) {
    this.vendoredAssetsDir = deps.vendoredAssetsDir;
    this.userPluginsDir = deps.userPluginsDir;
    this.fs = deps.fs;
    this.httpClient = deps.httpClient;
    this.logger = deps.logger ?? (() => {});
  }

  /** 两个 harness manifest 共用一个 plugin version。分歧属于 authority error：选择任一副本都会让
   *  另一 runtime 失真。 */
  private pluginVersion(pluginDir: string): string {
    const versions = PLUGIN_MANIFESTS
      .map((rel) => nodePath.join(pluginDir, rel))
      .filter((path) => this.fs.exists(path))
      .map((path) => {
        let parsed: { version?: unknown };
        try {
          parsed = JSON.parse(this.fs.readFile(path)) as { version?: unknown };
        } catch {
          throw new Error(`[plugin-vendor] ${path} 中的 plugin manifest 无效`);
        }
        if (typeof parsed.version !== "string") {
          throw new Error(`[plugin-vendor] ${path} 中的 plugin manifest 没有 string version`);
        }
        parseNumericVersion(parsed.version, path);
        return parsed.version;
      });
    if (versions.length === 0) {
      throw new Error(`[plugin-vendor] 在 ${pluginDir} 下未找到 plugin manifest`);
    }
    if (versions.some((version) => version !== versions[0])) {
      throw new Error(`[plugin-vendor] ${pluginDir} 下的 plugin manifest 不一致：${versions.join(", ")}`);
    }
    return versions[0]!;
  }

  /**
   * 当 user plugin dir <userPluginsDir>/<pluginName> 缺失时，将
   * <vendoredAssetsDir>/<pluginName>/ 中的 vendored asset tree seed 进去；只有 bundled manifest
   * version 严格更新时才推进。version 相等时，仅对逐字相同的文件 reconcile mode。vendored asset
   * 不存在（例如 plugin 未 bundled）时 no-op。
   */
  async ensureVendored(pluginName: string): Promise<void> {
    const sourceDir = nodePath.join(this.vendoredAssetsDir, pluginName);
    const targetDir = nodePath.join(this.userPluginsDir, pluginName);

    if (!this.fs.exists(sourceDir)) {
      this.logger(`[plugin-vendor] ${sourceDir} 中没有 "${pluginName}" 的 vendored asset；跳过`);
      return;
    }

    const sourceVersion = this.pluginVersion(sourceDir);
    if (this.fs.exists(targetDir)) {
      const hasTargetManifest = PLUGIN_MANIFESTS.some((rel) => this.fs.exists(nodePath.join(targetDir, rel)));
      if (!hasTargetManifest) {
        this.logger(`[plugin-vendor] ${targetDir} 中的现有 plugin '${pluginName}' 没有 version authority；保持不变`);
        return;
      }
      const targetVersion = this.pluginVersion(targetDir);
      const order = compareVersions(sourceVersion, targetVersion);
      if (order < 0) {
        this.logger(`[plugin-vendor] bundled '${pluginName}' ${sourceVersion} 不比 installed ${targetVersion} 新；保持已安装内容不变`);
        return;
      }
      if (order === 0) {
        // version 相等时，installed byte 具有权威性。仍修复逐字相同 path 的 mode：这是 metadata
        // reconciliation，不是 rollback，并保留既有 executable-helper 修复。
        for (const relPath of this.fs.listFiles(sourceDir)) {
          const srcPath = nodePath.join(sourceDir, relPath);
          const destPath = nodePath.join(targetDir, relPath);
          if (
            this.fs.exists(destPath) &&
            hashContent(this.fs.readFile(destPath)) === hashContent(this.fs.readFile(srcPath))
          ) {
            this.preserveMode(srcPath, destPath);
          }
        }
        this.logger(`[plugin-vendor] bundled '${pluginName}' ${sourceVersion} 与 installed ${targetVersion} 相等；保持已安装内容不变`);
        return;
      }
    }

    this.fs.mkdirp(targetDir);

    const files = this.fs.listFiles(sourceDir);
    for (const relPath of files) {
      const srcPath = nodePath.join(sourceDir, relPath);
      const destPath = nodePath.join(targetDir, relPath);
      const content = this.fs.readFile(srcPath);
      // hash-skip：仅在 content 不同时写入（幂等重跑）。即使 skip 也 reconcile mode——此前 staging
      // 的逐字相同副本仍可能带错误的默认 mode。
      if (this.fs.exists(destPath) && hashContent(this.fs.readFile(destPath)) === hashContent(content)) {
        this.preserveMode(srcPath, destPath);
        continue;
      }
      this.fs.mkdirp(nodePath.dirname(destPath));
      this.fs.writeFile(destPath, content);
      this.preserveMode(srcPath, destPath);
    }
  }

  /**
   * 将源文件的权限位重新应用到暂存/投影目标。普通 readFile+writeFile（writeFileSync）会按进程
   * 默认权限创建目标，导致嵌套插件辅助程序的可执行位丢失，例如
   * claude-compaction-restore/scripts/*.mjs 的 0755。该供应暂存步骤
   *（assets → ~/.openrig/plugins）位于适配器 CWD 投影上游；若此处不修复权限，暂存副本会停留在
   * 0644，之后适配器又会忠实保留这个错误权限。fs 适配器未公开权限原语时不执行任何操作，
   * 保持现有 mock-fs 调用方不受影响。
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  /** 将一个 plugin skill 投影到 harness-global skill root。 */
  ensureSkillGlobally(
    pluginName: string,
    skillName: string,
    globalSkillRoots: string[],
  ): void {
    const sourceDir = nodePath.join(
      this.userPluginsDir,
      pluginName,
      "skills",
      skillName,
    );
    if (!this.fs.exists(sourceDir)) {
      throw new Error(
        `plugin '${pluginName}' 中缺少必需的 global seed '${skillName}'`,
      );
    }

    const sourceVersion = this.pluginVersion(nodePath.join(this.userPluginsDir, pluginName));
    const files = this.fs.listFiles(sourceDir);
    for (const root of globalSkillRoots) {
      const targetDir = nodePath.join(root, skillName);
      const versionMarker = nodePath.join(targetDir, GLOBAL_VENDOR_VERSION);
      if (this.fs.exists(targetDir)) {
        if (!this.fs.exists(versionMarker)) {
          this.logger(`[plugin-vendor] ${targetDir} 中的 global skill '${skillName}' 属于 unversioned/external authority；保持不变`);
          continue;
        }
        const targetVersion = this.fs.readFile(versionMarker).trim();
        parseNumericVersion(targetVersion, versionMarker);
        if (compareVersions(sourceVersion, targetVersion) <= 0) {
          this.logger(`[plugin-vendor] global skill '${skillName}' ${targetVersion} 等于或新于 bundled ${sourceVersion}；保持不变`);
          continue;
        }
      }
      this.fs.mkdirp(targetDir);
      for (const relPath of files) {
        const srcPath = nodePath.join(sourceDir, relPath);
        const destPath = nodePath.join(targetDir, relPath);
        const content = this.fs.readFile(srcPath);
        if (
          this.fs.exists(destPath) &&
          hashContent(this.fs.readFile(destPath)) === hashContent(content)
        ) {
          this.preserveMode(srcPath, destPath);
          continue;
        }
        this.fs.mkdirp(nodePath.dirname(destPath));
        this.fs.writeFile(destPath, content);
        this.preserveMode(srcPath, destPath);
      }
      this.fs.writeFile(versionMarker, `${sourceVersion}\n`);
    }
  }

  /**
   * 尝试从 github.com/mvschwarz/openrig-plugins 获取最新 plugin tree。静默容忍 404、network error
   * 与 timeout——vendored copy 始终作为 fallback。记录 outcome 供 operator 观测。
   */
  async attemptAutoFetch(pluginName: string): Promise<void> {
    const url = `${REPO_BASE}/releases/latest/download/${pluginName}.tar.gz`;
    try {
      const response = await this.httpClient(url, { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!response.ok) {
        if (response.status === 404) {
          this.logger(`[plugin-vendor] fetch ${pluginName} 返回 404（repo 为空或 release 尚未发布）；回退到 vendored 版本`);
        } else {
          this.logger(`[plugin-vendor] fetch ${pluginName} 返回状态 ${response.status}；回退到 vendored 版本`);
        }
        return;
      }
      // v0：未实现 tarball extraction——slice 3.6 落地 marketplace consumption 后，
      // fetch-then-extract logic 将位于此处。目前 success 路径只记录日志。显式 MODE 决策：v0 不在
      // 此处写文件，因此没有 mode 需要保留；未来 extract 路径必须通过 preserveMode()（或能保留
      // mode 的 tar extractor）写入，使 fetched executable helper 保持 0755——与
      // ensureVendored/ensureSkillGlobally 使用同一 invariant。
      this.logger(`[plugin-vendor] fetch ${pluginName} 成功（${response.status}）；v0 仍以 vendored 版本为准`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger(`[plugin-vendor] fetch ${pluginName} 失败：${msg}；回退到 vendored 版本`);
    }
  }

  /**
   * 编排 vendored-first，再尝试 fetch。先解析本地 vendored/installed authority，使 fetch 路径因
   * 任意原因失败时仍保留可用本地副本。
   */
  async ensureLatest(pluginName: string): Promise<void> {
    await this.ensureVendored(pluginName);
    await this.attemptAutoFetch(pluginName);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
