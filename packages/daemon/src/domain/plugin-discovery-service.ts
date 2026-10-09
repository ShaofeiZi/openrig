// Phase 3a slice 3.3 —— 插件发现服务。
//
// SC-29 例外 #8 声明：Slice 3.3（UI 插件界面）需要后台服务侧 plugin-discovery-service 和
// 三条 HTTP 路由（GET /api/plugins、GET /api/plugins/:id、GET /api/plugins/:id/used-by）
// 作为支撑 API。不新增状态、SQL 迁移或变更路由。只读发现界面按 DESIGN.md §5.4 聚合文件系统
// 扫描并集。IMPL-PRD §3.3 的“代码改动”已明确分配此工作；此处按已记录的 SC-29 声明规则记载。
//
// 功能说明（DESIGN.md §5.4——自动发现资料库属于派生视图）：
//   - 扫描 3 个文件系统根目录中的插件清单：
//       * ~/.openrig/plugins/<id>/                         (vendored)
//       * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/   (claude cache)
//       * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/    (codex cache)
//   - 返回聚合列表，并按源根目录标注来源。
//   - getPlugin(id) 读取 .claude-plugin/plugin.json 和/或
//     .codex-plugin/plugin.json，并汇总目录树（skills/、hooks、mcp_servers 等），
//     使 UI 查看器无需重新读取文件即可展示插件内容。
//   - findUsedBy(id) 解析规范库中的 agent.yaml，遍历 resources.plugins[].id 收集
//     引用。它操作解析后的 YAML 结构，而不是字符串搜索，因此注释和相邻文本不会
//     产生假阳性。
//
// 便于分支合并：本服务只依赖文件系统读取和解析后的 YAML，不依赖
// plugin-primitive-v0 分支第 1 批的 PluginResource 类型。它读取的 agent YAML
// 结构（resources.plugins[].id + profile.uses.plugins[]）正是第 1 批生成的结构，
// 因此合并后服务无需修改即可继续工作。

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export type PluginRuntime = "claude" | "codex";
// Slice 3.3 修复 C——按 DESIGN §5.4 联合集合加入第 4 类 `rig-cwd` 来源：工作组随附的
// `<cwd>/.claude/plugins/*` 和 `<cwd>/.codex/plugins/*`，即 IMPL-PRD §1.2 的投影目标。
// 对应 velocity-qa 虚拟机验证失败 #3。
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache" | "rig-cwd";

export interface PluginEntry {
  /** 用于路由的稳定 ID（`openrig-core`、`<marketplace>:<plugin>:<version>`）。 */
  id: string;
  /** 插件在清单中声明的名称。 */
  name: string;
  /** 插件声明的版本。 */
  version: string;
  /** 清单中的可选描述。 */
  description: string | null;
  /** 发现此插件的源根目录。 */
  source: PluginSourceKind;
  /**
   * 按 DESIGN.md §5.4 与 IMPL-PRD §3.2 定义的人类可读来源标签：
   *   - `vendored:<plugin>`
   *   - `claude-cache:<marketplace>/<plugin>/<version>`
   *   - `codex-cache:<marketplace>/<plugin>/<version>`
   */
  sourceLabel: string;
  /** 插件支持的运行时（根据清单目录是否存在判断）。 */
  runtimes: PluginRuntime[];
  /** 插件根目录的文件系统路径。 */
  path: string;
  /**
   * 清单文件的 mtime，用作 UI 列表视图中“最近加载”的近似值；精确的“由运行时加载”时间戳
   * 不在 v0 范围内。
   */
  lastSeenAt: string | null;
  /**
   * Slice 28——`<plugin>/skills/` 下随包提供的技能目录数量。在列表响应中呈现，使
   * PluginsIndexPage 无须为每个插件行执行一次 N+1 详情获取即可渲染技能数量列。
   * 在 detectPlugin 时统计，只对 skills/ 执行一次 readdir。
   *
   * SC-29 例外 #11（slice 28 资料库浏览器收尾）：向 PluginEntry 添加 skillCount 字段，
   * 属于插件发现 API 契约的增量形态变更。遵循已记录的行内台账纪律，并在
   * routes/plugins.ts 文件头逐字声明。
   */
  skillCount: number;
}

export interface PluginManifestSummary {
  /** 来自 `<plugin>/.claude-plugin/plugin.json` 的原始清单对象。 */
  raw: Record<string, unknown>;
  /** 为便于使用而提取的字段（尽力而为；缺失时为 null）。 */
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  /** 技能文件夹名称。 */
  name: string;
  /** 相对于插件根目录的路径。 */
  relativePath: string;
}

export interface PluginHookSummary {
  /** 此 hook 配置针对的运行时。 */
  runtime: PluginRuntime;
  /** 相对于插件根目录的路径。 */
  relativePath: string;
  /** 声明的 hook 事件名（尽力解析）。 */
  events: string[];
}

// Slice 3.3 修复 A——MCP 服务器发现（DESIGN §5.7 + IMPL-PRD §3.2）。
// 插件随附的 MCP 服务器由运行时插件加载器处理；OpenRig 只呈现清单声明，使 UI
// 查看器可以列出“此插件提供哪些 MCP 服务器”。实现方式：读取 manifest.mcpServers
// （Claude/Codex 规范键），为每个声明的服务器生成一条摘要。尽力而为：字段缺失或
// 结构不同时返回 []，而不是抛出异常。
export interface PluginMcpServerSummary {
  /** 声明此 MCP 服务器的运行时清单。 */
  runtime: PluginRuntime;
  /** 服务器名称（清单 mcpServers 映射中的对象键）。 */
  name: string;
  /** 条目为 stdio 风格规范时声明的命令。 */
  command: string | null;
  /** 条目公开传输方式时声明的 transport（stdio/http 等）。 */
  transport: string | null;
}

export interface PluginDetail {
  /** 列表视图条目。 */
  entry: PluginEntry;
  /** 若存在，则为解析后的 `.claude-plugin/plugin.json`。 */
  claudeManifest: PluginManifestSummary | null;
  /** 若存在，则为解析后的 `.codex-plugin/plugin.json`。 */
  codexManifest: PluginManifestSummary | null;
  /** `<plugin>/skills/` 下随插件提供的技能文件夹。 */
  skills: PluginSkillSummary[];
  /** `<plugin>/hooks/` 下随插件提供的 hook 配置。 */
  hooks: PluginHookSummary[];
  /**
   * 来自 Claude/Codex 清单 `mcpServers` 字段的 MCP 服务器声明。
   * Slice 3.3 修复 A——velocity-qa 虚拟机验证失败 #1。
   */
  mcpServers: PluginMcpServerSummary[];
}

export interface AgentReference {
  /** 智能体名称（来自 agent.yaml 的 `name` 字段）。 */
  agentName: string;
  /** agent.yaml 的绝对路径。 */
  sourcePath: string;
  /** 在 uses.plugins[] 中包含此插件的配置名称。 */
  profiles: string[];
}

export interface PluginDiscoveryServiceOpts {
  /** OpenRig 内置插件的根目录（通常为 ~/.openrig/plugins）。 */
  openrigPluginsDir: string;
  /** Claude Code 插件缓存根目录（通常为 ~/.claude/plugins/cache）。 */
  claudeCacheDir: string;
  /** Codex 插件缓存根目录（通常为 ~/.codex/plugins/cache）。 */
  codexCacheDir: string;
  /**
   * 包含 agent.yaml 文件的规范库目录（递归扫描）。通常是后台服务解析出的规范库
   * 根目录。v0 可只使用单个根；若规范库后续贯通完整根目录列表，可在后续切片扩展
   * 为多个根。
   */
  specLibraryDir: string;
  /**
   * Slice 3.3 修复 C——可选的工作组 cwd 根目录；扫描其中 `.claude/plugins/*` 和
   * `.codex/plugins/*` 子目录，以发现工作组随附插件（IMPL-PRD §1.2 的投影目标）。默认为空。
   * v0 由 API 层通过 listPlugins({ cwdScanRoots })（?cwd=<path>）逐调用填充；后续切片可增加
   * 根据运行中工作组状态自动枚举。
   */
  cwdScanRoots?: string[];
}

export interface ListPluginsOpts {
  /** 筛选支持特定运行时的插件。 */
  runtimeFilter?: PluginRuntime;
  /** 筛选来自特定源根目录的插件。 */
  sourceFilter?: PluginSourceKind;
  /**
   * Slice 3.3 修复 C——逐调用工作组 cwd 根目录，覆盖构造器选项。每个 cwd 贡献
   * `<cwd>/.claude/plugins/*` 和 `<cwd>/.codex/plugins/*` 的发现结果，并标记为
   * `rig-cwd:<plugin>`。API 层向此处传递单个 `?cwd=<path>` 查询参数。
   */
  cwdScanRoots?: string[];
}

const CLAUDE_MANIFEST_REL = ".claude-plugin/plugin.json";
const CODEX_MANIFEST_REL = ".codex-plugin/plugin.json";
const OBSOLETE_LAB_PLUGIN_ID = "openrig-lab";

export class PluginDiscoveryService {
  private readonly opts: PluginDiscoveryServiceOpts;

  constructor(opts: PluginDiscoveryServiceOpts) {
    this.opts = opts;
    this.retireObsoleteLabRefocusHooks();
    this.assertNoDuplicateVendoredHooks();
  }

  listPlugins(filterOpts: ListPluginsOpts = {}): PluginEntry[] {
    const out: PluginEntry[] = [];

    // 1. OpenRig 内置插件。
    if (existsSync(this.opts.openrigPluginsDir)) {
      for (const entry of safeReaddir(this.opts.openrigPluginsDir)) {
        const pluginPath = join(this.opts.openrigPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const detected = this.detectPlugin(pluginPath, "vendored", entry);
        if (detected) out.push(detected);
      }
    }

    // 2. Claude Code 缓存：~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.claudeCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.claudeCacheDir)) {
        const marketplacePath = join(this.opts.claudeCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `claude-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `claude-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "claude-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    // 3. Codex 缓存：~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/
    if (existsSync(this.opts.codexCacheDir)) {
      for (const marketplace of safeReaddir(this.opts.codexCacheDir)) {
        const marketplacePath = join(this.opts.codexCacheDir, marketplace);
        if (!isDir(marketplacePath)) continue;
        for (const plugin of safeReaddir(marketplacePath)) {
          const pluginRoot = join(marketplacePath, plugin);
          if (!isDir(pluginRoot)) continue;
          for (const version of safeReaddir(pluginRoot)) {
            const versionPath = join(pluginRoot, version);
            if (!isDir(versionPath)) continue;
            const id = `codex-cache:${marketplace}/${plugin}/${version}`;
            const sourceLabel = `codex-cache:${marketplace}/${plugin}/${version}`;
            const detected = this.detectPlugin(versionPath, "codex-cache", id, sourceLabel);
            if (detected) out.push(detected);
          }
        }
      }
    }

    // 4. Slice 3.3 fix-C —— 工作组随 cwd 提供的插件根目录。
    // 逐调用选项覆盖构造选项；若两者都存在，以逐调用值直接替换而非追加，因为 API
    // 层 ?cwd=<path> 的意图是“此特定工作组可见的所有插件”，结果需可预测且可缓存。
    const effectiveCwds = filterOpts.cwdScanRoots ?? this.opts.cwdScanRoots ?? [];
    for (const cwd of effectiveCwds) {
      this.scanCwdBundledPlugins(cwd, out);
    }

    let filtered = out;
    if (filterOpts.runtimeFilter) {
      filtered = filtered.filter((p) => p.runtimes.includes(filterOpts.runtimeFilter!));
    }
    if (filterOpts.sourceFilter) {
      filtered = filtered.filter((p) => p.source === filterOpts.sourceFilter);
    }
    return filtered;
  }

  // Slice 3.3 修复 C——扫描单个工作组 cwd 中的 `.claude/plugins/*` 和
  // `.codex/plugins/*` 包。每发现一份插件清单就输出一个 PluginEntry；检测规则与其他来源根
  // 相同，即插件目录内存在 `.claude-plugin/plugin.json` 和/或 `.codex-plugin/plugin.json`。
  private scanCwdBundledPlugins(cwd: string, out: PluginEntry[]): void {
    if (!existsSync(cwd)) return;
    const claudePluginsDir = join(cwd, ".claude", "plugins");
    if (existsSync(claudePluginsDir)) {
      for (const entry of safeReaddir(claudePluginsDir)) {
        const pluginPath = join(claudePluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.claude/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }
    const codexPluginsDir = join(cwd, ".codex", "plugins");
    if (existsSync(codexPluginsDir)) {
      for (const entry of safeReaddir(codexPluginsDir)) {
        const pluginPath = join(codexPluginsDir, entry);
        if (!isDir(pluginPath)) continue;
        const id = `rig-cwd:${cwd}/.codex/plugins/${entry}`;
        const sourceLabel = `rig-cwd:${basename(cwd)}/${entry}`;
        const detected = this.detectPlugin(pluginPath, "rig-cwd", id, sourceLabel);
        if (detected) out.push(detected);
      }
    }
  }

  getPlugin(id: string): PluginDetail | null {
    // Slice 3.3 修复迭代——rig-cwd: ID 可自行解析。修复前 getPlugin 调用不带选项的
    // this.listPlugins()；由于 cwdScanRoots 默认为空，它会排除 rig-cwd 条目。结果是
    // /api/plugins?cwd= 返回 rig-cwd ID，而 /api/plugins/:id 对同一 ID 返回 404。
    // 修复方式：从 rig-cwd: 前缀解析 cwd，并作为 cwdScanRoots 传入，使条目出现在
    // 列表中。ID 格式由以下位置构造：
    // scanCwdBundledPlugins:
    //   rig-cwd:<cwd>/.claude/plugins/<plugin>
    //   rig-cwd:<cwd>/.codex/plugins/<plugin>
    const cwdScanRoots = extractCwdFromRigCwdId(id);
    const entry = this.listPlugins(cwdScanRoots ? { cwdScanRoots } : {}).find((p) => p.id === id);
    if (!entry) return null;

    const claudeManifestPath = join(entry.path, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(entry.path, CODEX_MANIFEST_REL);

    const claudeManifest = readManifest(claudeManifestPath);
    const codexManifest = readManifest(codexManifestPath);

    const skills: PluginSkillSummary[] = [];
    const skillsDir = join(entry.path, "skills");
    if (existsSync(skillsDir)) {
      for (const skillName of safeReaddir(skillsDir)) {
        const skillPath = join(skillsDir, skillName);
        if (isDir(skillPath)) {
          skills.push({ name: skillName, relativePath: `skills/${skillName}` });
        }
      }
    }

    const hooks: PluginHookSummary[] = [];
    const hooksDir = join(entry.path, "hooks");
    if (existsSync(hooksDir)) {
      const claudeHooks = join(hooksDir, "claude.json");
      if (existsSync(claudeHooks)) {
        hooks.push({
          runtime: "claude",
          relativePath: "hooks/claude.json",
          events: extractHookEvents(claudeHooks),
        });
      }
      const codexHooks = join(hooksDir, "codex.json");
      if (existsSync(codexHooks)) {
        hooks.push({
          runtime: "codex",
          relativePath: "hooks/codex.json",
          events: extractHookEvents(codexHooks),
        });
      }
    }

    // Slice 3.3 fix-A —— 从各运行时清单发现 MCP 服务器。
    const mcpServers: PluginMcpServerSummary[] = [
      ...readMcpServers(claudeManifest, "claude"),
      ...readMcpServers(codexManifest, "codex"),
    ];

    return { entry, claudeManifest, codexManifest, skills, hooks, mcpServers };
  }

  findUsedBy(pluginId: string): AgentReference[] {
    const refs: AgentReference[] = [];
    if (!existsSync(this.opts.specLibraryDir)) return refs;

    for (const candidate of walkAgentYamls(this.opts.specLibraryDir)) {
      const parsed = safeParseYaml(candidate.content);
      if (!parsed || typeof parsed !== "object") continue;

      const resourcesPlugins = readResourcesPlugins(parsed);
      const declaresThisPlugin = resourcesPlugins.some((p) => p === pluginId);
      if (!declaresThisPlugin) continue;

      const profiles = readProfilesUsingPlugin(parsed, pluginId);
      const agentName = readField(parsed, "name");
      if (!agentName) continue;
      refs.push({ agentName, sourcePath: candidate.path, profiles });
    }
    return refs;
  }

  // -- 辅助函数 --

  /**
   * openrig-core 成为唯一 refocus 提供方前，openrig-lab 曾提供相同登记。升级安装
   * 可能保留旧 lab 插件，因此验证未知冲突前只移除其中的 refocus 命令。先写 hook
   * 注册表：即使迁移中断，过时提供方仍保持禁用，哪怕其清单仍指向现已清空的注册表。
   */
  private retireObsoleteLabRefocusHooks(): void {
    const pluginPath = join(this.opts.openrigPluginsDir, OBSOLETE_LAB_PLUGIN_ID);
    if (!isDir(pluginPath)) return;

    for (const manifestRel of [CLAUDE_MANIFEST_REL, CODEX_MANIFEST_REL]) {
      const manifestPath = join(pluginPath, manifestRel);
      const manifest = readManifest(manifestPath);
      if (manifest?.name !== OBSOLETE_LAB_PLUGIN_ID) continue;

      const hooksRef = manifest.raw["hooks"];
      if (typeof hooksRef !== "string" || !hooksRef.trim()) continue;

      const hooksPath = join(pluginPath, hooksRef);
      const registry = readJsonObject(hooksPath);
      if (!registry || !removeObsoleteLabRefocusCommands(registry)) continue;

      writeJsonAtomically(hooksPath, registry);
      if (!hasHookRegistrations(registry)) {
        delete manifest.raw["hooks"];
        writeJsonAtomically(manifestPath, manifest.raw);
      }
    }
  }

  /**
   * 运行时插件加载器会激活每份内置清单，因此两个插件登记同一 hook 会触发两次。
   * 在发现服务将这种加载结构描述为健康前先拒绝它。缓存条目不参与判断：多个缓存
   * 版本只是清单库存，不是同时运行的提供方。
   */
  private assertNoDuplicateVendoredHooks(): void {
    if (!existsSync(this.opts.openrigPluginsDir)) return;

    const seen = new Map<string, { pluginPath: string; hooksPath: string }>();
    for (const entry of safeReaddir(this.opts.openrigPluginsDir).sort()) {
      const pluginPath = join(this.opts.openrigPluginsDir, entry);
      if (!isDir(pluginPath)) continue;

      for (const [runtime, manifestRel] of [
        ["claude", CLAUDE_MANIFEST_REL],
        ["codex", CODEX_MANIFEST_REL],
      ] as const) {
        const manifest = readManifest(join(pluginPath, manifestRel));
        const hooksRef = manifest?.raw["hooks"];
        if (typeof hooksRef !== "string" || !hooksRef.trim()) continue;

        const hooksPath = join(pluginPath, hooksRef);
        for (const identity of extractHookIdentities(hooksPath, runtime, pluginPath)) {
          const prior = seen.get(identity);
          if (prior && prior.pluginPath !== pluginPath) {
            throw new Error(
              `Duplicate hook registration "${identity}" found in both ${prior.hooksPath} and ${hooksPath}. `
              + "Archive or disable one provider before loading plugins.",
            );
          }
          seen.set(identity, { pluginPath, hooksPath });
        }
      }
    }
  }

  private detectPlugin(
    pluginPath: string,
    source: PluginSourceKind,
    explicitId: string,
    explicitSourceLabel?: string,
  ): PluginEntry | null {
    const claudeManifestPath = join(pluginPath, CLAUDE_MANIFEST_REL);
    const codexManifestPath = join(pluginPath, CODEX_MANIFEST_REL);

    const hasClaude = existsSync(claudeManifestPath);
    const hasCodex = existsSync(codexManifestPath);
    if (!hasClaude && !hasCodex) return null;

    const runtimes: PluginRuntime[] = [];
    if (hasClaude) runtimes.push("claude");
    if (hasCodex) runtimes.push("codex");

    // 读取第一份可用清单以获取名称、版本和描述。
    const primaryManifestPath = hasClaude ? claudeManifestPath : codexManifestPath;
    const manifest = readManifest(primaryManifestPath);
    if (!manifest) return null;

    const name = manifest.name ?? basename(pluginPath);
    const version = manifest.version ?? "unknown";
    const description = manifest.description;

    const sourceLabel = explicitSourceLabel ?? `vendored:${name}`;
    let lastSeenAt: string | null = null;
    try {
      const stat = statSync(primaryManifestPath);
      lastSeenAt = stat.mtime.toISOString();
    } catch {
      lastSeenAt = null;
    }

    // Slice 28 —— skillCount：统计 <plugin>/skills/ 下的子目录。与 getPlugin()
    // 详情侧枚举一致，后者也会收集该路径下的子目录。此层不按 .md 过滤；每个随包
    // 技能目录都计数，无论是否已经包含 SKILL.md。
    let skillCount = 0;
    const skillsDir = join(pluginPath, "skills");
    if (existsSync(skillsDir)) {
      for (const entry of safeReaddir(skillsDir)) {
        if (isDir(join(skillsDir, entry))) skillCount += 1;
      }
    }

    return {
      id: explicitId,
      name,
      version,
      description,
      source,
      sourceLabel,
      runtimes,
      path: pluginPath,
      lastSeenAt,
      skillCount,
    };
  }
}

// Slice 3.3 修复迭代——从 rig-cwd: ID 解析 cwd，使 getPlugin 可在查找前重新扫描该
// cwd。以单元素数组返回 cwd（调用方将其作为 cwdScanRoots 传入）；ID 不是 rig-cwd:
// 形式、无法解析或两种清单目录标记均缺失时返回 null。同时容忍
// `/.claude/plugins/` 和 `/.codex/plugins/`，先出现者优先；规范 ID 中必有其一。
const RIG_CWD_PREFIX = "rig-cwd:";
const CLAUDE_MARKER = "/.claude/plugins/";
const CODEX_MARKER = "/.codex/plugins/";
function extractCwdFromRigCwdId(id: string): string[] | null {
  if (!id.startsWith(RIG_CWD_PREFIX)) return null;
  const rest = id.slice(RIG_CWD_PREFIX.length);
  const claudeIdx = rest.indexOf(CLAUDE_MARKER);
  const codexIdx = rest.indexOf(CODEX_MARKER);
  let cwd: string | null = null;
  if (claudeIdx >= 0 && (codexIdx < 0 || claudeIdx < codexIdx)) {
    cwd = rest.slice(0, claudeIdx);
  } else if (codexIdx >= 0) {
    cwd = rest.slice(0, codexIdx);
  }
  if (!cwd) return null;
  return [cwd];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(manifestPath: string): PluginManifestSummary | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return {
      raw,
      name: typeof raw.name === "string" ? raw.name : null,
      version: typeof raw.version === "string" ? raw.version : null,
      description: typeof raw.description === "string" ? raw.description : null,
      homepage: typeof raw.homepage === "string" ? raw.homepage : null,
      repository: typeof raw.repository === "string" ? raw.repository : null,
      license: typeof raw.license === "string" ? raw.license : null,
    };
  } catch {
    return null;
  }
}

// Slice 3.3 fix-A —— 从清单的 `mcpServers` 字段读取 MCP 服务器声明。Claude/Codex
// 插件规范约定为
// mcpServers: { <name>: { command, args, transport, ... } }。向 UI 呈现名称，并尽力提供
// command/transport。
function readMcpServers(
  manifest: PluginManifestSummary | null,
  runtime: PluginRuntime,
): PluginMcpServerSummary[] {
  if (!manifest) return [];
  const raw = manifest.raw;
  if (!raw || typeof raw !== "object") return [];
  const mcpServers = (raw as Record<string, unknown>)["mcpServers"];
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }
  const out: PluginMcpServerSummary[] = [];
  for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
    let command: string | null = null;
    let transport: string | null = null;
    if (value && typeof value === "object") {
      const config = value as Record<string, unknown>;
      if (typeof config.command === "string") command = config.command;
      if (typeof config.transport === "string") transport = config.transport;
    }
    out.push({ runtime, name, command, transport });
  }
  return out;
}

function extractHookEvents(hooksJsonPath: string): string[] {
  try {
    const data = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as { hooks?: Record<string, unknown> };
    if (data.hooks && typeof data.hooks === "object") {
      return Object.keys(data.hooks);
    }
  } catch {
      // 尽力而为。
  }
  return [];
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function removeObsoleteLabRefocusCommands(registry: Record<string, unknown>): boolean {
  if (!isObject(registry.hooks)) return false;

  let changed = false;
  for (const [event, rawGroups] of Object.entries(registry.hooks)) {
    if (!Array.isArray(rawGroups)) {
      if (isObsoleteLabRefocusHook(rawGroups)) {
        delete registry.hooks[event];
        changed = true;
      }
      continue;
    }

    const groups: unknown[] = [];
    for (const rawGroup of rawGroups) {
      if (!isObject(rawGroup)) {
        groups.push(rawGroup);
        continue;
      }
      if (!Array.isArray(rawGroup.hooks)) {
        if (isObsoleteLabRefocusHook(rawGroup)) {
          changed = true;
        } else {
          groups.push(rawGroup);
        }
        continue;
      }

      const hooks = rawGroup.hooks.filter((hook) => {
        const obsolete = isObsoleteLabRefocusHook(hook);
        if (obsolete) changed = true;
        return !obsolete;
      });
      if (hooks.length > 0) {
        groups.push(hooks.length === rawGroup.hooks.length ? rawGroup : { ...rawGroup, hooks });
      }
    }

    if (groups.length > 0) registry.hooks[event] = groups;
    else delete registry.hooks[event];
  }
  return changed;
}

function isObsoleteLabRefocusHook(value: unknown): boolean {
  if (!isObject(value) || typeof value.command !== "string") return false;
  return /(?:^|[\\/])hooks[\\/]scripts[\\/]refocus\.cjs(?:["'\s]|$)/.test(value.command);
}

function hasHookRegistrations(registry: Record<string, unknown>): boolean {
  return isObject(registry.hooks) && Object.keys(registry.hooks).length > 0;
}

function writeJsonAtomically(path: string, value: Record<string, unknown>): void {
  const tempPath = `${path}.openrig-migration-${process.pid}-${Date.now()}.tmp`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tempPath, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractHookIdentities(
  hooksJsonPath: string,
  runtime: PluginRuntime,
  pluginPath: string,
): string[] {
  try {
    const data = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as { hooks?: Record<string, unknown> };
    if (!data.hooks || typeof data.hooks !== "object") return [];

    const identities: string[] = [];
    for (const [event, rawGroups] of Object.entries(data.hooks)) {
      const groups = Array.isArray(rawGroups) ? rawGroups : [rawGroups];
      for (const rawGroup of groups) {
        if (!rawGroup || typeof rawGroup !== "object") continue;
        const group = rawGroup as Record<string, unknown>;
        const matcher = typeof group.matcher === "string" ? group.matcher : "";
        const rawHooks = Array.isArray(group.hooks) ? group.hooks : [group];
        for (const rawHook of rawHooks) {
          if (!rawHook || typeof rawHook !== "object") continue;
          const hook = rawHook as Record<string, unknown>;
          if (typeof hook.command !== "string") continue;
          const type = typeof hook.type === "string" ? hook.type : "command";
          const command = hook.command
            .split(pluginPath).join("<plugin-root>")
            .replace(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g, "<plugin-root>")
            .replace(/\s+/g, " ")
            .trim();
          identities.push(JSON.stringify([runtime, event, matcher, type, command]));
        }
      }
    }
    return identities;
  } catch {
    return [];
  }
}

interface AgentYamlCandidate {
  path: string;
  content: string;
}

function walkAgentYamls(rootDir: string): AgentYamlCandidate[] {
  const out: AgentYamlCandidate[] = [];
  walk(rootDir);
  return out;

  function walk(dir: string): void {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry);
      if (isDir(p)) {
        walk(p);
        continue;
      }
      if (entry === "agent.yaml" || entry === "agent.yml") {
        try {
          const content = readFileSync(p, "utf8");
          out.push({ path: p, content });
        } catch {
          // 尽力而为；跳过不可读文件。
        }
      }
    }
  }
}

function safeParseYaml(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return null;
  }
}

function readField(obj: unknown, field: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function readResourcesPlugins(spec: unknown): string[] {
  if (!spec || typeof spec !== "object") return [];
  const resources = (spec as Record<string, unknown>)["resources"];
  if (!resources || typeof resources !== "object") return [];
  const plugins = (resources as Record<string, unknown>)["plugins"];
  if (!Array.isArray(plugins)) return [];
  const ids: string[] = [];
  for (const p of plugins) {
    if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
      ids.push((p as Record<string, unknown>).id as string);
    } else if (typeof p === "string") {
      // 为向前兼容而容忍简写字符串形式。
      ids.push(p);
    }
  }
  return ids;
}

function readProfilesUsingPlugin(spec: unknown, pluginId: string): string[] {
  if (!spec || typeof spec !== "object") return [];
  const profiles = (spec as Record<string, unknown>)["profiles"];
  if (!profiles || typeof profiles !== "object") return [];
  const matched: string[] = [];
  for (const [profileName, profileVal] of Object.entries(profiles as Record<string, unknown>)) {
    if (!profileVal || typeof profileVal !== "object") continue;
    const uses = (profileVal as Record<string, unknown>)["uses"];
    if (!uses || typeof uses !== "object") continue;
    const usesPlugins = (uses as Record<string, unknown>)["plugins"];
    if (!Array.isArray(usesPlugins)) continue;
    if (usesPlugins.some((p) => p === pluginId)) {
      matched.push(profileName);
    }
  }
  return matched;
}
