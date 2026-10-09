import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExecDep = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export interface SearchResult {
  backend: "rg" | "grep" | "none";
  excerpts: string[];
  insufficient: boolean;
  noTranscriptDir?: boolean;
  error?: string;
}

/** 席位范围搜索的一条关键词命中，并标记它所属的 generation（任期）分段。各分段由席位
 * 日志跨任期累积的 `--- SESSION BOUNDARY … ---` 标记分隔。 */
export interface SeatHit {
  generation: number;
  text: string;
}

export type SeatDegradeReason =
  | "capture_missing"
  | "capture_empty"
  | "capture_unreadable"
  | "boundary_only";

export interface SeatSearchResult {
  backend: "read" | "none";
  seat: string;
  /** 任期分段数 = 已见边界标记数 + 1。 */
  generations: number;
  hits: SeatHit[];
  insufficient: boolean;
  /** 诚实降级信号——绝不以静默的零命中暗示席位从未发言。 */
  degraded?: { reason: SeatDegradeReason; message: string };
  /** 大文件提示（pin 5）——明确显示，绝不静默进行慢速读取。 */
  advisory?: string;
}

export interface ChatSearchResult {
  sender: string;
  body: string;
  createdAt: string;
}

interface HistoryQueryOpts {
  transcriptsRoot: string;
  exec: ExecDep;
  chatSearchFn?: (rigId: string, pattern: string) => ChatSearchResult[];
  /** 按会话存放 provider JSONL 的根目录（Claude）：~/.claude/projects；测试可注入。 */
  claudeProjectsRoot?: string;
}

export interface SessionSearchResult {
  backend: "rg" | "grep" | "none";
  token: string;
  found: boolean;
  path?: string;
  sizeBytes?: number;
  excerpts: string[];
  insufficient: boolean;
  degraded?: { reason: "session_not_found" | "unreadable"; message: string };
  advisory?: string;
}

const STOP_WORDS = new Set([
  "the", "is", "was", "are", "were", "been", "being",
  "have", "has", "had", "having",
  "does", "did", "doing",
  "will", "would", "shall", "should",
  "may", "might", "must", "can", "could",
  "and", "but", "for", "nor", "not", "yet", "also",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose",
  "where", "when", "why", "how",
  "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "than", "too", "very",
  "its", "his", "her", "our", "your", "their",
  "with", "from", "into", "about", "between", "through",
  "during", "before", "after", "above", "below",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JSONL 事件行可能很大；限制回显长度以保持命中内容可读。 */
function truncateExcerpt(line: string, max = 240): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function extractKeywords(question: string): string[] {
  const words = question.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of words) {
    // 检查停用词时移除尾部标点，但转义时仍以原词为基础。
    const stripped = word.replace(/[?.!,;:]+$/, "");
    if (stripped.length < 3) continue;
    if (STOP_WORDS.has(stripped.toLowerCase())) continue;

    const escaped = escapeRegex(word.replace(/[?.!,;:]+$/, ""));
    if (seen.has(escaped)) continue;
    seen.add(escaped);
    result.push(escaped);
  }

  return result;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_: string, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\[(\d*)G/g, (_: string, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** 匹配会话边界标记行（transcript-store.writeBoundaryMarker 格式）：
 * `--- SESSION BOUNDARY: <reason> at <ts> ---`。 */
const SEAT_BOUNDARY_RE = /^--- SESSION BOUNDARY: .* at .* ---\s*$/;

/** 席位搜索超过此大小时显示大文件提示（pin 5），而不是静默读取；完整读取仍会执行，
 * 但调用方会得到明确通知。 */
const SEAT_LARGE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export class HistoryQuery {
  private readonly transcriptsRoot: string;
  private readonly exec: ExecDep;
  private readonly chatSearchFn?: (rigId: string, pattern: string) => ChatSearchResult[];
  private readonly claudeProjectsRoot: string;

  constructor(opts: HistoryQueryOpts) {
    this.transcriptsRoot = opts.transcriptsRoot;
    this.exec = opts.exec;
    this.chatSearchFn = opts.chatSearchFn;
    this.claudeProjectsRoot = opts.claudeProjectsRoot ?? join(homedir(), ".claude", "projects");
  }

  /** 根据 token 定位会话 JSONL：`<projectsRoot>/<any-encoded-cwd>/<token>.jsonl`。只需 token
   * 即可，因为会扫描各 encoded-cwd 目录；对应创建者的“我有 token，去找到它”要求。无匹配
   * 时返回 null。 */
  private locateSessionFile(token: string): string | null {
    const root = this.claudeProjectsRoot;
    if (!existsSync(root)) return null;
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = join(root, d, `${token}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * L2——按 token 只读搜索单个会话的 JSONL。在
   * ~/.claude/projects/<encoded-cwd>/<token>.jsonl 下定位文件，并以 rg→grep 回退顺序搜索；
   * 流式处理使数百 MB 的会话文件也保持安全。保持诚实：没有对应会话文件的 token 返回
   * session_not_found 指导，绝不静默返回空；大文件会显示提示（pin 5）。
   */
  async searchSession(sessionToken: string, question: string): Promise<SessionSearchResult> {
    const filePath = this.locateSessionFile(sessionToken);
    if (!filePath) {
      return {
        backend: "none",
        token: sessionToken,
        found: false,
        excerpts: [],
        insufficient: true,
        degraded: {
          reason: "session_not_found",
          message: `在 ${this.claudeProjectsRoot} 下未找到 token '${sessionToken}' 对应的会话 JSONL。请检查 token；该会话也可能运行在其他主机或 home 下。`,
        },
      };
    }

    let sizeBytes: number;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      return {
        backend: "none",
        token: sessionToken,
        found: true,
        path: filePath,
        excerpts: [],
        insufficient: true,
        degraded: { reason: "unreadable", message: `token '${sessionToken}' 对应的会话 JSONL 存在，但无法读取。` },
      };
    }

    const advisory = sizeBytes > SEAT_LARGE_FILE_BYTES
      ? `会话 JSONL 较大（${(sizeBytes / 1024 / 1024).toFixed(1)} MB）；搜索会通过 rg/grep 流式执行，宽泛查询可能需要一些时间。`
      : undefined;

    const keywords = extractKeywords(question);
    if (keywords.length === 0) {
      return { backend: "none", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts: [], insufficient: true, advisory };
    }
    const pattern = keywords.join("|");

    const rg = await this.exec("rg", ["-i", "--no-filename", "-e", pattern, filePath]);
    if (rg.exitCode === 0 || rg.exitCode === 1) {
      const excerpts = this.parseExcerpts(rg.stdout).map((e) => truncateExcerpt(e));
      return { backend: "rg", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts, insufficient: excerpts.length === 0, advisory };
    }

    const grep = await this.exec("grep", ["-E", "-i", "-h", "-e", pattern, filePath]);
    if (grep.exitCode === 0 || grep.exitCode === 1) {
      const excerpts = this.parseExcerpts(grep.stdout).map((e) => truncateExcerpt(e));
      return { backend: "grep", token: sessionToken, found: true, path: filePath, sizeBytes, excerpts, insufficient: excerpts.length === 0, advisory };
    }

    return {
      backend: "none",
      token: sessionToken,
      found: true,
      path: filePath,
      sizeBytes,
      excerpts: [],
      insufficient: true,
      advisory,
      degraded: { reason: "unreadable", message: "搜索后端（rg、grep）均无法处理该会话 JSONL。" },
    };
  }

  async search(rigName: string, question: string): Promise<SearchResult> {
    const rigDir = join(this.transcriptsRoot, rigName);

    if (!existsSync(rigDir)) {
      return { backend: "rg", excerpts: [], insufficient: true, noTranscriptDir: true };
    }

    const keywords = extractKeywords(question);
    if (keywords.length === 0) {
      return { backend: "none", excerpts: [], insufficient: true };
    }

    const pattern = keywords.join("|");

    // 优先尝试 rg；使用 -e 避免以连字符开头的模式被解析为选项。
    const rgResult = await this.exec("rg", ["-i", "--no-filename", "-e", pattern, rigDir]);

    if (rgResult.exitCode === 0 || rgResult.exitCode === 1) {
      const excerpts = this.parseExcerpts(rgResult.stdout);
      // 退出码 0 = 找到匹配，1 = 无匹配 → 信息不足。
      return { backend: "rg", excerpts, insufficient: excerpts.length === 0 };
    }

    // rg 失败（退出码 >= 2），回退到 grep。
    const logFiles = this.getLogFiles(rigDir);
    if (logFiles.length === 0) {
      return { backend: "grep", excerpts: [], insufficient: true };
    }

    // grep 同样使用 -e，避免以连字符开头的模式被解析为选项。
    const grepResult = await this.exec("grep", ["-E", "-i", "-h", "-e", pattern, ...logFiles]);

    if (grepResult.exitCode === 0 || grepResult.exitCode === 1) {
      const excerpts = this.parseExcerpts(grepResult.stdout);
      return { backend: "grep", excerpts, insufficient: excerpts.length === 0 };
    }

    // 两个后端都失败（退出码 2+）——如实报错。
    return { backend: "none", excerpts: [], insufficient: true, error: "搜索后端（rg、grep）均失败。请确认已安装 rg 或 grep，且转录目录可读。" };
  }

  /**
   * L1——席位范围、跨 generation 的转录搜索。范围只限一个席位的
   * `<rig>/<sessionName>.log`，绝不搜索整个工作组目录；每条命中都标记所属 generation
   *（任期）。generation 是智能体更替时席位日志中累积的 `--- SESSION BOUNDARY … ---`
   * 标记之间的分段。跨 generation 正是此功能重点：同一关键词在边界前后均命中，可证明
   * 搜索跨越任期。诚实降级，绝不静默返回零命中：转录缺失、为空或只有边界都会明确说明。
   */
  async searchSeat(rigName: string, seatSessionName: string, question: string): Promise<SeatSearchResult> {
    const base = { backend: "read" as const, seat: seatSessionName, generations: 0, hits: [] as SeatHit[] };
    const filePath = join(this.transcriptsRoot, rigName, `${seatSessionName}.log`);

    if (!existsSync(filePath)) {
      return {
        ...base,
        insufficient: true,
        degraded: {
          reason: "capture_missing",
          message: `工作组 '${rigName}' 的席位 '${seatSessionName}' 没有捕获到转录——该席位可能从未在此主机上受管，或转录捕获已禁用。这不能证明该席位从未发言。`,
        },
      };
    }

    let sizeBytes: number;
    let content: string;
    try {
      sizeBytes = statSync(filePath).size;
      if (sizeBytes === 0) {
        return {
          ...base,
          insufficient: true,
          degraded: {
            reason: "capture_empty",
            message: `席位 '${seatSessionName}' 的转录为空（0 字节）——尚无捕获历史，但不能证明该席位从未发言。`,
          },
        };
      }
      content = readFileSync(filePath, "utf-8");
    } catch {
      return {
        ...base,
        insufficient: true,
        degraded: {
          reason: "capture_unreadable",
          message: `席位 '${seatSessionName}' 的转录存在，但无法读取（可能是权限或瞬时文件系统错误）。`,
        },
      };
    }

    const advisory = sizeBytes > SEAT_LARGE_FILE_BYTES
      ? `转录较大（${(sizeBytes / 1024 / 1024).toFixed(1)} MB）；已读取完整文件。对于非常大的席位历史，建议提出更具体的问题。`
      : undefined;

    const keywords = extractKeywords(question);
    const pattern = keywords.length > 0 ? new RegExp(keywords.join("|"), "i") : null;

    let generation = 1;
    let sawConversation = false;
    const hits: SeatHit[] = [];
    for (const raw of content.split("\n")) {
      if (SEAT_BOUNDARY_RE.test(raw)) {
        generation += 1;
        continue;
      }
      const line = stripAnsi(raw).trim();
      if (line === "") continue;
      sawConversation = true;
      if (pattern && pattern.test(line)) hits.push({ generation, text: line });
    }
    const generations = generation; // 边界数 + 1。

    if (!sawConversation) {
      return {
        ...base,
        generations,
        insufficient: true,
        advisory,
        degraded: {
          reason: "boundary_only",
          message: `席位 '${seatSessionName}' 的转录只包含会话边界标记，没有捕获到对话。此主机可能只捕获转录边界；记录处于降级状态，并非不存在。`,
        },
      };
    }

    if (!pattern) {
      return { backend: "none", seat: seatSessionName, generations, hits: [], insufficient: true, advisory };
    }

    return { ...base, generations, hits, insufficient: hits.length === 0, advisory };
  }

  private parseExcerpts(stdout: string): string[] {
    if (!stdout.trim()) return [];
    return stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => stripAnsi(line).trim())
      .filter((line) => line !== "");
  }

  searchChat(rigId: string, question: string): ChatSearchResult[] {
    if (!this.chatSearchFn) return [];
    const keywords = extractKeywords(question);
    if (keywords.length === 0) return [];
    const pattern = keywords.join("|");
    return this.chatSearchFn(rigId, pattern);
  }

  private getLogFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  }
}
