import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";
import type { ResolvedStartupFile } from "./runtime-adapter.js";

/**
 * Agent Starter v1 纵向切片（M1）的后台服务端产品化解析器。
 * 与 v0 包装层 `bin/agent-starter-resolve` 的语义一致：读取指定注册表条目，
 * 执行路径感知的无凭据扫描；扫描失败时抛出异常（编排器必须把任何异常视为
 * 启动硬失败）；扫描通过后，生成以注册表目录为根的 `ResolvedStartupFile[]`。
 *
 * v0 包装器参考：
 * - 规范说明：`specs/agent-starters/SCHEMA.md` § 无凭据证明
 *   （同时感知路径和内容；允许 transcript_path 指向
 *   ~/.claude/projects/ or ~/.openrig/transcripts/).
 * - 拒绝动作：`specs/agent-starters/bin/agent-starter-resolve` 第 22-31 行
 *   （通过 `scan_starter_file` 预检；拒绝原因为
 *   credential_path_disallowed / credential_content_disallowed).
 *
 * 解析器结构参考：
 * `session-source-rebuild-resolver.ts:31-90`.
 */

export type ExistsFn = (path: string) => boolean;
export type ReadFileFn = (path: string) => string;

export interface AgentStarterResolverOpts {
  /** 可选的绝对路径覆盖值；设置后跳过查找链。 */
  registryRoot?: string;
  /**
   * 查找链第二顺位读取的环境变量。默认为
   * `OPENRIG_AGENT_STARTER_ROOT`.
   */
  envVarName?: string;
  /**
   * 查找链第三顺位读取的主目录根路径。默认为
   * `~/.openrig/agent-starters/`（相对于 `process.env.HOME` 或
   * `os.homedir()`).
   */
  homeDirRoot?: string;
  /** 主目录注册表不存在时最后采用的可选回退路径。 */
  fallbackRoot?: string;
  exists?: ExistsFn;
  readFile?: ReadFileFn;
  /** 测试接缝：允许单元测试注入受控的环境变量映射。 */
  env?: Record<string, string | undefined>;
}

export interface AgentStarterResolveResult {
  files: ResolvedStartupFile[];
  registryPath: string;
}

/**
 * `resolveStarter` 的无凭据扫描失败时抛出。解析器必须抛出异常，不能返回
 * 可能被编排器忽略的结构化 `ok: false` 结果；扫描失败是中止启动的硬拒绝点。
 */
export class AgentStarterCredentialScanFailedError extends Error {
  readonly starterName: string;
  readonly reason: string;
  constructor(starterName: string, reason: string) {
    super(`Agent Starter“${starterName}”的凭据扫描失败：${reason}`);
    this.name = "AgentStarterCredentialScanFailedError";
    this.starterName = starterName;
    this.reason = reason;
  }
}

const DEFAULT_ENV_VAR = "OPENRIG_AGENT_STARTER_ROOT";
const DEFAULT_HOME_SUBPATH = ".openrig/agent-starters";
export class AgentStarterResolver {
  private readonly registryRoot: string;
  private readonly exists: ExistsFn;
  private readonly readFile: ReadFileFn;

  constructor(opts: AgentStarterResolverOpts = {}) {
    this.exists = opts.exists ?? existsSync;
    this.readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    this.registryRoot = AgentStarterResolver.resolveRegistryRoot(opts, this.exists);
  }

  /** 向测试和诊断开放。 */
  getRegistryRoot(): string {
    return this.registryRoot;
  }

  /**
   * 按文档约定的顺序查找注册表根目录：
   *   opts.registryRoot > env[envVarName] > homeDirRoot (if exists) > fallbackRoot
   *
   * 即使路径不存在也返回回退值。所选根目录无效时，`resolveStarter` 会抛出
   * 条目缺失错误。这样构造函数不产生副作用，文件存在性检查集中在
   * `resolveStarter`.
   */
  static resolveRegistryRoot(
    opts: AgentStarterResolverOpts,
    exists: ExistsFn,
  ): string {
    if (typeof opts.registryRoot === "string" && opts.registryRoot !== "") {
      return opts.registryRoot;
    }
    const env = opts.env ?? process.env;
    const envVarName = opts.envVarName ?? DEFAULT_ENV_VAR;
    const fromEnv = env[envVarName];
    if (typeof fromEnv === "string" && fromEnv !== "") {
      return fromEnv;
    }
    const homeBase = opts.homeDirRoot
      ?? join(env.HOME ?? os.homedir(), DEFAULT_HOME_SUBPATH);
    if (exists(homeBase)) {
      return homeBase;
    }
    return opts.fallbackRoot ?? homeBase;
  }

  /**
   * 按注册表名称解析 starter。以下情况会抛出异常：
   * - 注册表条目缺失（不存在 `<root>/<name>.yaml`）；
   * - YAML 格式异常（尽力检测空文件或无法解析的 front-matter 结构；M1
   *   为缩小依赖面，不在驱动中引入 YAML 解析器）；
   * - 无凭据扫描失败（`AgentStarterCredentialScanFailedError`）。
   *
   * 扫描通过后生成 `ResolvedStartupFile[]`。v1 M1 的脚手架结构为：starter
   * 声明的每个注册表相对文件对应一个条目（目前就是注册表条目 YAML 本身，
   * 按 guidance_merge 内容处理；M2/M3 接线完成后，后续里程碑可扩展解析器，
   * 遍历 priming-pack 清单中的 `read_full` 路径）。所有生成文件都标记为
   * `appliesOn: ["fresh_start"]`，因为 starter 上下文用于初始化全新启动的会话。
   */
  resolveStarter(name: string): AgentStarterResolveResult {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      throw new Error(
        `Agent Starter 解析器：名称 ${JSON.stringify(name)} 无效（必须由字母或数字开头，后续可包含“_”或“-”）`,
      );
    }
    const registryPath = join(this.registryRoot, `${name}.yaml`);
    if (!this.exists(registryPath)) {
      throw new Error(
        `Agent Starter 解析器：在 ${registryPath} 未找到注册表条目`,
      );
    }
    let content: string;
    try {
      content = this.readFile(registryPath);
    } catch (err) {
      throw new Error(
        `Agent Starter 解析器：读取 ${registryPath} 失败：${(err as Error).message}`,
      );
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        `Agent Starter 解析器：${registryPath} 为空或不可读`,
      );
    }
    // 冒烟检查文件是否符合 YAML front-matter 结构：必须包含 `starter_id:` 行。
    // 这可维持 M1 的窄依赖面（不引入 YAML 解析器）；M2 遍历 priming-pack
    // 清单时可替换成真正的解析器。
    if (!/^starter_id:\s*\S+/m.test(content)) {
      throw new Error(
        `Agent Starter 解析器：${registryPath} 不符合注册表条目结构（缺少“starter_id:”字段）`,
      );
    }

    // 同时感知路径和内容的凭据扫描。其行为与 v0 包装器辅助脚本
    // `specs/agent-starters/lib/agent-starter-helpers.sh` 中的
    // `scan_starter_file` 一致。匹配时直接抛出异常，不返回可恢复结果。
    const scanResult = scanForCredentials(content, registryPath);
    if (!scanResult.ok) {
      throw new AgentStarterCredentialScanFailedError(name, scanResult.reason);
    }

    // M1 脚手架结构：用一个 ResolvedStartupFile 指向注册表条目本身。编排器的
    // `deliverStartup` 接缝已接受 `deliveryHint: "guidance_merge"`。若端到端证明
    // 需要更丰富的分层产物，后续里程碑（M2 实例化器集成、M3 Claude 端到端、
    // M4 Codex 对齐）可扩展解析器，遍历 priming-pack 清单中的 `read_full` 路径。
    // M1 在此锁定的是类型契约和拒绝语义。
    const files: ResolvedStartupFile[] = [
      {
        path: basename(registryPath),
        absolutePath: registryPath,
        ownerRoot: this.registryRoot,
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["fresh_start"],
      },
    ];

    return { files, registryPath };
  }
}

// --- 无凭据扫描（与 `lib/agent-starter-helpers.sh::scan_starter_file` 一致）---

const CRED_PATH_LITERALS = [
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".aws/credentials",
  ".ssh/",
];

const CRED_PATH_RE = /(credentials|auth\.json|secrets|tokens?\.json)([^a-zA-Z0-9._-]|$)/;
const CRED_STRING_RE = /(api[_-]?key|secret[_-]?key|bearer[_-]?token|sk-[A-Za-z0-9]{20,}|gh[ps]_[A-Za-z0-9]{20,}|password[\s]*[:=])/i;

function scanForCredentials(
  content: string,
  filePath: string,
): { ok: true } | { ok: false; reason: string } {
  // 白名单例外：接受 `transcript_path` 字段中位于 `~/.claude/projects/` 或
  // `~/.openrig/transcripts/` 下的值（与 v0 包装器一致）；相同路径若出现在其他
  // 字段、键或注释中，则作为可疑复制而拒绝。
  const transcriptPath = extractFieldValue(content, "transcript_path");

  let lineNo = 0;
  for (const rawLine of content.split("\n")) {
    lineNo += 1;
    const line = rawLine;

    // 仅对 transcript_path 自身所在行检查白名单。
    const stripped = line.replace(/^\s+/, "");
    let isAllowlistedTranscript = false;
    if (transcriptPath && stripped.startsWith("transcript_path:")) {
      if (
        transcriptPath.includes("/.claude/projects/")
        || transcriptPath.includes("/.openrig/transcripts/")
      ) {
        isAllowlistedTranscript = true;
      }
    }

    // 1. 凭据路径字面量。
    // 拒绝原因会刻意隐去匹配行内容。后台服务层解析器会把错误消息送入日志/API
    // 响应；回显匹配行会泄露拒绝列表本应拦截的凭据内容。操作员只需拒绝码、
    // 行号和文件路径即可排查。这在后台服务产品化层消除了 v0 包装器诊断中
    // `match` 字段可能泄露内容的问题。
    for (const literal of CRED_PATH_LITERALS) {
      if (line.includes(literal)) {
        return {
          ok: false,
          reason: `credential_path_disallowed：${filePath} 第 ${lineNo} 行匹配拒绝列表中的凭据路径字面量（内容已隐去）`,
        };
      }
    }

    // 2. 路径正则（credentials|auth.json|secrets|tokens.json）。
    if (!isAllowlistedTranscript && CRED_PATH_RE.test(line)) {
      return {
        ok: false,
        reason: `credential_path_disallowed：${filePath} 第 ${lineNo} 行匹配凭据路径模式（内容已隐去）`,
      };
    }

    // 3. 凭据字符串正则（不区分大小写）。
    if (CRED_STRING_RE.test(line)) {
      return {
        ok: false,
        reason: `credential_content_disallowed：${filePath} 第 ${lineNo} 行匹配凭据内容模式（内容已隐去）`,
      };
    }
  }

  return { ok: true };
}

function extractFieldValue(content: string, field: string): string {
  const re = new RegExp(`^\\s*${field}:\\s*(.*?)\\s*$`, "m");
  const match = content.match(re);
  if (!match || !match[1]) return "";
  return match[1].replace(/^['"]|['"]$/g, "").trim();
}
