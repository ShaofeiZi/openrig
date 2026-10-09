import { belongsToProject } from "../workspace/project-catalog.js";
// Slice Story View v0 —— 切片索引器。
//
// 从配置的文件系统根读取切片目录。默认工作区契约为
// `workspace/missions/<mission>/slices/<slice>`；为兼容性仍支持显式配置的扁平根
// `workspace/slices/<slice>`。索引器解析每个切片的 frontmatter 与验收章节标记，
// 并结合已发布的数据表（queue_items、queue_transitions、mission_control_actions）
// 和 dogfood-evidence 目录，对外提供规范化 Slice 记录。
//
// MVP 场景为单开发者、单用户、单主机。v0 以切片目录作为可导航实体。不新增
// SQLite 迁移或事件类型，只对现有数据与文件系统做只读投影。

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { parseScopeTags } from "./qitem-membership.js";
import { resolveNodeFile, withSpecFirst } from "../scope/node-file.js";

export type SliceStatus = "active" | "done" | "blocked" | "draft";

export interface SliceQitemRef {
  qitemId: string;
  state: string;
  sourceSession: string;
  destinationSession: string;
  tier: string | null;
  tsUpdated: string;
}

export interface SliceProofPacket {
  /** dogfood-evidence 根目录下的目录名。 */
  dirName: string;
  /** 磁盘上的绝对路径。 */
  absPath: string;
  /** Markdown 文件路径（相对于 dirName），按 mtime 从新到旧排列。 */
  markdownFiles: string[];
  /** 可内联渲染的图片路径（相对于 dirName）。 */
  screenshots: string[];
  /** 视频文件路径（相对于 dirName）；QA 尚未捕获视频时为空数组。 */
  videos: string[];
  /** trace zip 路径（相对于 dirName）。 */
  traces: string[];
  /** 目录 mtime（ISO 字符串）。 */
  mtime: string;
}

/** V0.3.1 slice 13 walk-item 7——frontmatter 中的
 *  `workflow_spec: <name>@<version>` 声明。设置后，即使没有绑定实时
 *  workflow_instance，拓扑标签页也会通过 WorkflowSpecCache.getByNameVersion
 *  与 projectSpecGraph 从该声明投影规范图。字段缺失或格式错误时为 null。 */
export interface WorkflowSpecRef {
  name: string;
  version: string;
}

export interface SliceRecord {
  /** 文件夹名称（规范 ID）。 */
  name: string;
  /** 在 missions/<mission>/slices/<slice> 下发现时的任务目标目录 ID。 */
  missionId: string | null;
  /** 切片目录的文件系统绝对路径。 */
  slicePath: string;
  /** 来自 frontmatter 或第一个 H1 的展示名；缺失时回退为 name。 */
  displayName: string;
  /** 从 frontmatter 解析的可选 rail-item 编号（PL-005、PL-019 等）。 */
  railItem: string | null;
  /** 从 frontmatter status 字段映射得到的状态。 */
  status: SliceStatus;
  /** frontmatter 中的原始状态字符串（用于调试）。 */
  rawStatus: string | null;
  /** 在 queue_items 中按 frontmatter rail-item 或正文切片名匹配并关联的 qitem ID。 */
  qitemIds: string[];
  /** 从 frontmatter 解析的 commit 引用（phase-X-shipped-commits、target-commit 等）。 */
  commitRefs: string[];
  /** 最近匹配的 dogfood-evidence 目录（或 null）。 */
  proofPacket: SliceProofPacket | null;
  /** 切片目录 mtime 与匹配 qitem 的 ts_updated 中的最大值。 */
  lastActivityAt: string | null;
  /** frontmatter 引用的来源（例如 PRD、planner brief）。 */
  files: string[];
  /** 解析后的 frontmatter `workflow_spec: <name>@<version>` 声明；缺失或格式错误时为 null。 */
  workflowSpec: WorkflowSpecRef | null;
}

export interface SliceListEntry {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  /** 镜像 SliceRecord.workflowSpec；缺失或格式错误时为 null。 */
  workflowSpec: WorkflowSpecRef | null;
  status: SliceStatus;
  rawStatus: string | null;
  /** OPR.0.3.2.17——来自切片主文档（README/IMPLEMENTATION-PRD/PROGRESS）
   *  frontmatter 的 `description` / `summary`。叙事适配器将其作为
   *  `rawStatus === "candidate"` 切片的 ConceptCard.oneLiner；缺失时为 null。 */
  description: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  /** PL-007——切片文件夹的绝对文件系统路径。UI 将其与
   *  RigSpec.workspace.repos[].path / knowledgeRoot 匹配以解析工作区类型。
   *  始终由 toListEntry 填充。 */
  slicePath: string;
}

export interface SliceIndexerOpts {
  projectId?: string;
  missionId?: string;
  /** 包含切片目录的根目录。 */
  slicesRoot: string;
  /** 主根目录之后扫描的其他兼容根目录。 */
  additionalSliceRoots?: string[];
  /** 包含 dogfood-evidence 目录的根目录。 */
  dogfoodEvidenceRoot: string | null;
  /** 用于只读关联 queue_items、transitions 与 actions 的 SQLite 句柄。 */
  db: Database.Database;
  /** 缓存 TTL（毫秒），默认 60_000（60 秒）；过期后的下一次请求会重新遍历。 */
  cacheTtlMs?: number;
}

interface CachedListing {
  entries: SliceListEntry[];
  expiresAt: number;
}

interface CachedSlice {
  record: SliceRecord;
  expiresAt: number;
}

interface SliceLocation {
  name: string;
  missionId: string | null;
  slicePath: string;
}

/** qitem-ccf87c0d——每一代的批量成员关系索引。它用每代两次流式扫描取代
 *  逐切片 queue_items 扫描（353 次一级通配符 + ORDER BY 扫描，再加每个无类型
 *  切片最多 3 次正文 LIKE 扫描；主机规模冷启动约需 10 秒并同步阻塞事件循环）。
 *  语义与逐切片路径逐字节等价，并由测试锁定：类型化权威门控（VM-004）、按
 *  ts_created DESC/qitem_id DESC 排序且每切片最多 500 条已确认记录、术语优先的
 *  回退组装、SQL-LIKE 仅 ASCII 大小写折叠、可跨换行的 %/_ 通配符，以及每个术语
 *  最多 500 条。预先检查 schema 形态（qitem-18110994）：queue_items 不存在时，
 *  发布带位置元数据的结构性空索引；tags 列不存在时跳过类型化扫描并使用仅正文
 *  的回退；任何 PRAGMA、类型化或回退执行失败都向调用方传播，不降级也不缓存。 */
interface MembershipIndex {
  /** 切片名 -> 已确认的类型化 qitem ID（扫描顺序为 ts DESC、id DESC；每切片最多 500 条）。 */
  typedBySlice: Map<string, string[]>;
  /** 切片名 -> 按作者优先级排列的可用回退术语。 */
  fallbackTermsBySlice: Map<string, string[]>;
  /** 回退术语 -> 按行（rowid）顺序排列的 qitem ID；每个术语最多 500 条。 */
  fallbackByTerm: Map<string, string[]>;
  /** 构建索引时使用的位置名集合。若 get() 遇到操作期间新建且不在集合中的文件夹，
   *  会强制重建，使新文件夹按与原逐切片路径完全相同的方式解析成员关系。 */
  knownSlices: Set<string>;
}

// --- 与 SQL LIKE 等价的匹配（qitem-ccf87c0d）-------------------------
// 逐字节复现 SQLite LIKE 语义（由测试锁定）：
//   - 仅折叠 ASCII 大小写（A-Z <-> a-z；æ 与 Æ 不折叠）；
//   - `%` 匹配任意长度字符，`_` 恰好匹配一个字符（码点）；两者都可跨越换行与
//     辅助平面字符（一个代理对算一个 `_`）。因此转换后的正则必须带 `su` 标志
//     （见下方 LIKE_REGEXP_FLAGS）：dotAll 负责换行，`u` 负责按码点步进。若转换为
//     [\s\S] 会按 UTF-16 码元计数，从而漏掉 `%a_b%` 对 `a😀b` 的匹配（守卫阻断钉）；
//   - 其余每个字节都按字面量处理（转义正则特殊字符）。

/** 所有转换后 LIKE 正则统一使用的标志集。 */
const LIKE_REGEXP_FLAGS = "su";

/** 只把 ASCII A-Z 转为小写，不处理 Unicode（与 SQLite LIKE 的折叠行为一致）。 */
function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** qitem-18f3300d——SQLite LIKE 在待匹配文本的第一个原始 U+0000 处停止
 *  （守卫已对父级逐切片 SQL 复现；POST /api/queue/create 的 JSON 正文可在生产中
 *  带入 NUL）。必须在 asciiFold、预筛选和确认之前应用，确保只出现在 NUL 之后的
 *  术语永不匹配，与父级实现完全一致。 */
function sqliteVisiblePrefix(s: string): string {
  const i = s.indexOf("\u0000");
  return i === -1 ? s : s.slice(0, i);
}

/** 转换一段 LIKE 模式字符：%/_ 为通配符，其余字符按字面量处理并转义正则特殊字符。
 *  此处不加锚点；仅当 LIKE 全匹配语义与“包含”不同，由调用方补上。 */
function likePatternBodyToRegExpSource(patternBody: string): string {
  let out = "";
  for (const ch of patternBody) {
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return out;
}

/** qitem-18f3300d 的模式侧处理：按父级 SQL 实际看到的内容转换某个回退术语的
 *  完整绑定 LIKE 模式。先构造 `%<term>%`，再于第一个 U+0000 处截断模式（SQLite
 *  也会截断模式；术语内部的 NUL 会丢掉尾部通配符，留下以 `%prefix` 结尾锚定的形式）。
 *  - 未截断模式（绝大多数不含 NUL 的情况）：`%term%` 就是“包含”匹配，因此不加锚点。
 *    无通配符术语会编译为纯字面量，让组合预筛选的分支继续走正则引擎的快速字面量路径。
 *    带锚点的 `^.*x.*$` 在基准测试中慢约 80 倍，因为每个不匹配行都要为每个分支做贪婪扫描。
 *  - 已截断模式：尾部 `%` 丢失后，LIKE 全匹配语义变得重要，因此逐字转换截断模式，
 *    并加上 `^...$` 锚点。
 *  使用 LIKE_REGEXP_FLAGS 编译。 */
function likeBoundPatternToRegExpSource(term: string): string {
  const bound = `%${term}%`;
  const pattern = sqliteVisiblePrefix(bound);
  if (pattern === bound) {
    return likePatternBodyToRegExpSource(asciiFold(term));
  }
  return "^" + likePatternBodyToRegExpSource(asciiFold(pattern)) + "$";
}

const FRONTMATTER_DELIM = "---";
const DEFAULT_CACHE_TTL_MS = 60_000;

const STATUS_TO_BUCKET: Record<string, SliceStatus> = {
  active: "active",
  "in-flight": "active",
  ratified: "active",
  "draft-pending-orch-ratification": "draft",
  draft: "draft",
  // VM-005（release-0.4.7）：脚手架模板的 frontmatter 状态 TOKEN——新建的
  // `rig scope` 切片应如实属于 draft，而不是 active（此前会落入 mapStatus 的
  // 终端默认值）。它与 scaffold-placeholder 孪生模块的语法不同；后者分类的是
  // 方括号包裹的正文 TEXT，二者相关但该 frontmatter token 不属于后者。
  placeholder: "draft",
  done: "done",
  shipped: "done",
  promoted: "done",
  closed: "done",
  blocked: "blocked",
  "parked-with-evidence": "blocked",
};

export class SliceIndexer {
  readonly projectId?: string;
  readonly missionId?: string;
  readonly slicesRoot: string;
  readonly additionalSliceRoots: string[];
  readonly dogfoodEvidenceRoot: string | null;
  /** 规范库工作流 v0：以只读方式暴露，使切片路由的 `boundToWorkflow` 镜头筛选器
   *  能调用 `findSliceWorkflowBinding(db, qitemIds)`，无需在别处再次注入 db 句柄。
   *  内部调用方保持原用法；类外消费者只读。 */
  readonly db: Database.Database;
  private readonly cacheTtlMs: number;
  private listingCache: CachedListing | null = null;
  private detailCache: Map<string, CachedSlice> = new Map();
  // qitem-ccf87c0d——批量成员关系索引（见 MembershipIndex 说明）。
  private membershipIndex: MembershipIndex | null = null;
  // qitem-ccf87c0d 修正——当前打开的 withMembershipBatch 作用域深度。
  private batchDepth = 0;
  private compositionBasis: string | null = null;
  // VM-005：作者声明的任务状态 sidecar 缓存（与列表使用相同 TTL）。
  private missionStatusCache: {
    statuses: Record<string, { authoredStatus: string | null }>;
    expiresAt: number;
  } | null = null;

  constructor(opts: SliceIndexerOpts) {
    this.projectId = opts.projectId;
    this.missionId = opts.missionId;
    this.slicesRoot = opts.slicesRoot;
    this.additionalSliceRoots = opts.additionalSliceRoots ?? [];
    this.dogfoodEvidenceRoot = opts.dogfoodEvidenceRoot;
    this.db = opts.db;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** 任一已配置切片根目录存在于磁盘时返回 true。 */
  isReady(): boolean {
    return this.sliceRoots().some((root) => this.isDirectory(root));
  }

  /** qitem-ccf87c0d 修正——显式的复合操作作用域。调用方把 list() 加逐切片 get()
   *  视为一次用户可见操作时（切片路由的 boundToWorkflow 镜头、
   *  ReviewGatherer.composeMission），在此包裹，使内部所有 list/get 共享同一个成员关系
   *  批次，而不是为每个未缓存 get 各建一个批次（2+2N 回归）。测试锁定的契约：
   *   - 最外层进入绝不复用上一次操作的批次；会丢弃现有批次。索引按需构建，因此作用域内
   *     第一次成员关系访问会读取当时的队列状态，保证请求边界新鲜度，但不宣称快照一致性；
   *   - 嵌套或重入作用域共享最外层批次；
   *   - 最外层退出始终在 finally 中清理，故不同操作绝不共享同一代；
   *   - 不在作用域内的独立 list()/get() 保持各自的一次操作批次语义（仅 depth === 0 时清理）。
   *  设计为同步，以匹配同步的 list/get 调用图。 */
  withMembershipBatch<T>(fn: () => T): T {
    if (this.batchDepth === 0) this.reconcileComposition();
    if (this.batchDepth === 0) this.membershipIndex = null;
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
  }

  /** 清除两个缓存，供测试和未来显式刷新路由使用。 */
  invalidate(): void {
    this.listingCache = null;
    this.detailCache.clear();
    this.missionStatusCache = null;
    this.membershipIndex = null;
  }

  /** VM-005 B1（狭窄的 C-vii 例外；架构裁定 b8d91aee…）——写后读接缝。
   *  POST /:missionId/complete 会写入任务 README 状态；若不处理，sidecar 的 60 秒 TTL
   *  会让 /api/slices 继续返回写入前的词，而 /api/missions/:id 已从磁盘读到新词。
   *  此处只丢弃整个 missionStatusCache，不动列表/详情缓存。采用“丢整块”而非全量刷新，
   *  因为后者不会增加一致性，却会引入 60 秒的注册表抖动。唯一写路径在成功后调用它；
   *  下次读取从磁盘重建（README 是 SSOT）。带外文件写入按设计仍遵循 TTL。 */
  invalidateMissionStatusCache(): void {
    this.missionStatusCache = null;
  }

  /** VM-005（release-0.4.7）——切片列表负载的作者任务状态 sidecar。
   *  对每个已索引任务读取一次任务 README frontmatter，并与列表共用 60 秒缓存纪律。
   *  键仅包含至少一个已索引切片的任务；零切片任务没有索引切片，因而不会出现在这里，
   *  该类任务由树的发现遍历负责。读取语义与 routes/missions.ts 的 readMissionStatus
   *  严格同步：只读 README.md、返回原始字符串、不校验枚举、结果为非空值或 null；由测试锁定。 */
  missionAuthoredStatuses(): Record<string, { authoredStatus: string | null }> {
    if (!this.isReady()) return {};
    const now = Date.now();
    if (this.missionStatusCache && this.missionStatusCache.expiresAt > now) {
      return this.missionStatusCache.statuses;
    }
    const indexedMissionIds = new Set<string>();
    for (const entry of this.list()) {
      if (entry.missionId) indexedMissionIds.add(entry.missionId);
    }
    const statuses: Record<string, { authoredStatus: string | null }> = {};
    for (const root of this.sliceRoots()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (!indexedMissionIds.has(entry.name)) continue;
      if (entry.name in statuses) continue; // 第一个根目录优先，与切片遍历一致。
        statuses[entry.name] = {
          authoredStatus: this.readMissionAuthoredStatus(path.join(root, entry.name)),
        };
      }
    }
    this.missionStatusCache = { statuses, expiresAt: now + this.cacheTtlMs };
    return statuses;
  }

  /** routes/missions.ts readMissionStatus 的同步孪生实现（参见上方 sidecar 说明；
   * 同步测试确保两个读取路径对相同字节得出一致结果）。 */
  private readMissionAuthoredStatus(missionPath: string): string | null {
    const readmePath = resolveNodeFile(missionPath);
    if (!readmePath) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(readmePath, "utf8");
    } catch {
      return null;
    }
    const fm = parseFrontmatter(raw);
    const value = fm["status"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  list(): SliceListEntry[] {
    if (!this.isReady()) return [];
    if (this.batchDepth === 0) this.reconcileComposition();
    const now = Date.now();
    if (this.listingCache && this.listingCache.expiresAt > now) {
      return this.listingCache.entries;
    }
    const locations = this.readSliceLocations();
    // 一个批量成员关系索引服务于整次重建（LIKE 执行次数不超过 4 的负载契约），随后
    // 立即丢弃，使后续未缓存操作读取当前队列状态（qitem-18f3300d 操作作用域）；
    // 除非外层 withMembershipBatch 作用域拥有该批次的生命周期。
    let entries: SliceListEntry[];
    try {
      // list() 返回每个位置，因此 served = ALL（null）。
      entries = locations.map((location) => this.toListEntry(location, null));
    } finally {
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
    this.listingCache = { entries, expiresAt: now + this.cacheTtlMs };
    return entries;
  }

  get(name: string): SliceRecord | null {
    if (!this.isReady()) return null;
    if (this.batchDepth === 0) this.reconcileComposition();
    const now = Date.now();
    const cached = this.detailCache.get(name);
    if (cached && cached.expiresAt > now) {
      return cached.record;
    }
    const location = this.findSliceLocation(name);
    if (!location) return null;

    // 未缓存的 get() 使用自己操作范围内的批次，随后丢弃，使下一次未缓存操作读到
    // 当前队列状态（qitem-18f3300d）；除非外层 withMembershipBatch 作用域拥有批次生命周期。
    let record: SliceRecord;
    try {
      // 独立的未缓存 get() 只返回一个切片，因此 served 为 {name}；在打开的
      // withMembershipBatch 范围内，操作是复合操作，served 为 ALL（null）。
      record = this.buildRecord(location, this.batchDepth > 0 ? null : new Set([name]));
    } finally {
      if (this.batchDepth === 0) this.membershipIndex = null;
    }
    this.detailCache.set(name, { record, expiresAt: now + this.cacheTtlMs });
    return record;
  }

  // 静默对账必须在旧元数据 TTL 到期前发现新的原生成员关系。这是基于作者内容字节和
  // 目录项的缓存键，不是另一套工作范围解析器。
  private reconcileComposition(): void {
    const rows = this.sliceRoots().flatMap(root => {
      if (!fs.existsSync(root)) return [];
      return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(entry => {
        const mission = path.join(root, entry.name), manifest = path.join(mission, "mission.yaml");
        if (!fs.existsSync(manifest)) return [];
        const children = path.join(mission, "slices");
        return [[manifest, fs.readFileSync(manifest, "utf8"), fs.existsSync(children) ? fs.readdirSync(children).sort() : []]];
      });
    });
    const next = JSON.stringify(rows);
    if (this.compositionBasis !== null && this.compositionBasis !== next) this.invalidate();
    this.compositionBasis = next;
  }

  // --- 内部实现 ---

  private readSliceLocations(): SliceLocation[] {
    const locations: SliceLocation[] = [];
    const seen = new Set<string>();
    const addLocation = (location: SliceLocation) => {
      if (seen.has(location.name)) return;
      seen.add(location.name);
      locations.push(location);
    };

    for (const root of this.sliceRoots()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const entryPath = path.join(root, entry.name);
        const nestedSlicesRoot = path.join(entryPath, "slices");
        if (this.isDirectory(nestedSlicesRoot)) {
          let nestedEntries: fs.Dirent[];
          try {
            nestedEntries = fs.readdirSync(nestedSlicesRoot, { withFileTypes: true });
          } catch {
            nestedEntries = [];
          }
          for (const nested of nestedEntries) {
            if (!nested.isDirectory() || nested.name.startsWith(".")) continue;
            addLocation({
              name: nested.name,
              missionId: entry.name,
              slicePath: path.join(nestedSlicesRoot, nested.name),
            });
          }
          continue;
        }
        addLocation({
          name: entry.name,
          missionId: null,
          slicePath: entryPath,
        });
      }
    }
    return locations.filter(location => !this.missionId || location.missionId === this.missionId).sort((a, b) => a.name.localeCompare(b.name));
  }

  private findSliceLocation(name: string): SliceLocation | null {
    return this.readSliceLocations().find((location) => location.name === name) ?? null;
  }

  private isDirectory(absPath: string): boolean {
    try {
      return fs.statSync(absPath).isDirectory();
    } catch {
      return false;
    }
  }

  private sliceRoots(): string[] {
    const roots = [this.slicesRoot, ...this.additionalSliceRoots].filter((root) => root.length > 0);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const root of roots) {
      const resolved = path.resolve(root);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(root);
    }
    return out;
  }

  private toListEntry(location: SliceLocation, served: Set<string> | null): SliceListEntry {
    const { name, missionId, slicePath } = location;
    const frontmatter = this.readPrimaryFrontmatter(slicePath);
    const status = this.mapStatus(frontmatter["status"] as string | undefined);
    const railItem = this.extractRailItem(frontmatter, missionId);
    const qitemIds = this.matchQitems(name, served);
    const proofPacket = this.findProofPacket(name);
    const lastActivityAt = this.computeLastActivity(slicePath, qitemIds, proofPacket);

    return {
      name,
      missionId,
      displayName: this.extractDisplayName(slicePath, frontmatter, name),
      railItem,
      workflowSpec: parseWorkflowSpecRef(frontmatter["workflow_spec"]),
      status,
      rawStatus: (frontmatter["status"] as string | undefined) ?? null,
      // OPR.0.3.2.17——公开 frontmatter 的 `description`（或回退 `summary`），
      // 让叙事适配器无需额外获取详情即可用作 ConceptCard.oneLiner。详情端点仍是完整
      // 正文的事实来源；此字段只是短摘要镜像。
      description: extractDescription(frontmatter),
      qitemCount: qitemIds.length,
      hasProofPacket: proofPacket !== null,
      lastActivityAt,
      slicePath,
    };
  }

  private buildRecord(location: SliceLocation, served: Set<string> | null): SliceRecord {
    const { name, missionId, slicePath } = location;
    const frontmatter = this.readPrimaryFrontmatter(slicePath);
    const status = this.mapStatus(frontmatter["status"] as string | undefined);
    const railItem = this.extractRailItem(frontmatter, missionId);
    const qitemIds = this.matchQitems(name, served);
    const proofPacket = this.findProofPacket(name);
    const lastActivityAt = this.computeLastActivity(slicePath, qitemIds, proofPacket);
    const commitRefs = this.extractCommitRefs(frontmatter);
    const files = this.listSliceFiles(slicePath);

    return {
      name,
      missionId,
      slicePath,
      displayName: this.extractDisplayName(slicePath, frontmatter, name),
      railItem,
      status,
      rawStatus: (frontmatter["status"] as string | undefined) ?? null,
      qitemIds,
      commitRefs,
      proofPacket,
      lastActivityAt,
      files,
      workflowSpec: parseWorkflowSpecRef(frontmatter["workflow_spec"]),
    };
  }

  private readPrimaryFrontmatter(slicePath: string): Record<string, unknown> {
    // 按文档顺序合并规范切片 frontmatter，并把 PROGRESS.md 放在最后，使当前生命周期
    // 游标覆盖旧的派发元数据；当 PROGRESS.md 稀疏时，README.md/IMPLEMENTATION-PRD.md
    // 仍可提供切片标题、rail item 和来源引用。
    // 此合并以后者为准（见下方 Object.assign），所以节点文件必须放在 README.md 一直占据
    // 的槽位，而不是最前面。若把 SPEC.md 前置，陈旧的 README.md 或 IMPLEMENTATION-PRD.md
    // 会在两者同时存在的节点上逐字段静默覆盖实时 SPEC.md，而这些节点正是兼容逻辑要服务的。
    // 只解析一个节点文件并维持其周围原顺序；PROGRESS.md 继续最后充当生命周期游标。
    const selectedNode = resolveNodeFile(slicePath);
    const candidates = [
      "IMPLEMENTATION-PRD.md",
      ...(selectedNode ? [path.basename(selectedNode)] : []),
      "PROGRESS.md",
    ];
    const merged: Record<string, unknown> = {};
    for (const candidate of candidates) {
      const fullPath = path.join(slicePath, candidate);
      if (!fs.existsSync(fullPath)) continue;
      const fm = parseFrontmatter(fs.readFileSync(fullPath, "utf8"));
      if (Object.keys(fm).length > 0) {
        Object.assign(merged, fm);
      }
    }
    if (Object.keys(merged).length > 0) return merged;

    // 某些切片此时只有 planner brief；尽力兼容任意 planner-brief 结构。
    try {
      const entries = fs.readdirSync(slicePath, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const fm = parseFrontmatter(fs.readFileSync(path.join(slicePath, e.name), "utf8"));
        if (Object.keys(fm).length > 0) return fm;
      }
    } catch {
      // 切片目录不可读时返回空结果。
    }
    return {};
  }

  private extractDisplayName(slicePath: string, frontmatter: Record<string, unknown>, fallback: string): string {
    if (typeof frontmatter["title"] === "string") return frontmatter["title"] as string;
    if (typeof frontmatter["slice"] === "string") return frontmatter["slice"] as string;
    // 从主文档提取第一个 H1。
    for (const candidate of withSpecFirst(["README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"])) {
      const fullPath = path.join(slicePath, candidate);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      const m = content.match(/^# (.+?)$/m);
      if (m && m[1]) return m[1].trim();
    }
    return fallback;
  }

  private extractRailItem(frontmatter: Record<string, unknown>, missionId: string | null): string | null {
    return this.extractExplicitRailItem(frontmatter) ?? missionId;
  }

  private extractExplicitRailItem(frontmatter: Record<string, unknown>): string | null {
    const raw = frontmatter["rail-item"];
    if (typeof raw === "string") {
      // 若 YAML 解析器把数组作为字符串（"[PL-008]"）返回，则移除数组括号。
      const stripped = raw.replace(/^\[|\]$/g, "").trim();
      if (stripped.length > 0) return stripped.split(",")[0]!.trim();
    }
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0];
    const related = frontmatter["related-rail-items"];
    if (typeof related === "string") {
      const stripped = related.replace(/^\[|\]$/g, "").trim();
      if (stripped.length > 0) return stripped.split(",")[0]!.trim();
    }
    if (Array.isArray(related) && related.length > 0 && typeof related[0] === "string") return related[0];
    return null;
  }

  private extractCommitRefs(frontmatter: Record<string, unknown>): string[] {
    const refs: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (typeof value !== "string") continue;
      // 匹配 phase-a-shipped-commits、target-commit、phase-a-base-commit 等键。
      if (!/commits?$/.test(key)) continue;
      // 启发式识别以逗号或空白分隔、长度至少 7 的十六进制 token。
      const tokens = value.split(/[\s,]+/).filter((t) => /^[0-9a-f]{7,40}$/i.test(t));
      refs.push(...tokens);
    }
    // 去重并保留顺序。
    return Array.from(new Set(refs));
  }

  private mapStatus(raw: string | undefined): SliceStatus {
    if (!raw) return "draft";
    const normalized = raw.toLowerCase().trim();
    if (STATUS_TO_BUCKET[normalized]) return STATUS_TO_BUCKET[normalized];
    // 启发式回退。
    if (normalized.includes("done") || normalized.includes("ship") || normalized.includes("close")) return "done";
    if (normalized.includes("block") || normalized.includes("park")) return "blocked";
    if (normalized.includes("draft") || normalized.includes("pending")) return "draft";
    return "active";
  }

  private matchQitems(sliceName: string, served: Set<string> | null): string[] {
    // V0.3.1 slice 17 founder-walk-workspace-state-correctness（walk item 3）：旧实现
    // 会合并 [sliceName, railItem, missionId] 的子串匹配，导致 missionId 过度匹配——
    // 带 `mission:<id>` 标签的每个 qitem 都出现在该任务的每个切片下。修正方式：当本切片
    // 已有类型化 `slice:<name>` 标签行时，从并集中移除 missionId 子串术语；类型化标签是
    // 权威的切片成员关系信号。对 qitem 集合早于类型化标签约定的切片，仍保留包含
    // missionId 的子串回退，避免旧的任务感知工作区回归。
    // qitem-ccf87c0d——两层现在都从每代批量成员关系索引回答（每代两次扫描，不再是
    // O(slices) 次；见 ensureMembershipIndex）。双层原则不变：信号层只回答规范类型化
    // 成员关系，展示层携带受门控的旧子串回退；绝不能把展示层匹配提升为信号（P3）。
    const ids = new Set<string>();
    {
      let index = this.ensureMembershipIndex(served);
      if (!index.knownSlices.has(sliceName)) {
        // 操作中途创建了文件夹：重建索引，使新切片立即解析成员关系，
        // 与旧逐切片查询保持一致。
        this.membershipIndex = null;
        index = this.ensureMembershipIndex(served);
      }
      // 1. 类型化标签匹配（VM-004 权威）：本切片的已确认行按
      // ts_created DESC/qitem_id DESC 扫描顺序排列，由构建器限制为每切片最多 500 条。
      const typed = index.typedBySlice.get(sliceName);
      if (typed && typed.length > 0) {
        for (const id of typed) ids.add(id);
      } else {
        // 2. 子串回退——仅在已确认类型化行数为零时执行（VM-004 的有意门控）。构建器
        // 确认任务是否采用类型化成员关系后，记录每个切片精确的可用术语。术语优先的
        // 组装方式保留每个术语原有的稳定顺序与上限。
        for (const term of index.fallbackTermsBySlice.get(sliceName) ?? []) {
          const bucket = index.fallbackByTerm.get(term);
          if (bucket) for (const id of bucket) ids.add(id);
        }
      }
    }
    // qitem-18110994（第 2 项）——已移除原先包裹本块的宽泛 catch。它本用于处理
    // “queue_items 表不存在”，现在由 ensureMembershipIndex 的 schema 探针结构化回答。
    // 若保留，REFUSED 构建会再次被吞掉并把拒绝缓存为空详情，从而破坏传播契约：真正的
    // 扫描故障必须到达调用方，不能伪装成没有成员关系的切片。
    // V0.3.1 slice 17 walk item 10——前向修复 #1。按 ts_created 对 qitemIds 降序排序，
    // 使切片详情的队列标签页先显示最新项（HG-5）。ScopePages.ScopeQueueRollup 前端仍做
    // 兜底排序，覆盖绕过本辅助函数的路径；但后端才是权威一致性点。ts_created 不可用时，
    // 回退为 qitem-id 字典序降序（ID 编码了 `qitem-YYYYMMDDHHMMSS-...` 时间戳前缀）。
    const idsArr = Array.from(ids);
    if (idsArr.length <= 1) return idsArr;
    try {
      const placeholders = idsArr.map(() => "?").join(",");
      const tsRows = this.db.prepare(
        `SELECT qitem_id, ts_created FROM queue_items WHERE qitem_id IN (${placeholders})`,
      ).all(...idsArr) as Array<{ qitem_id: string; ts_created: string | null }>;
      const tsByQitemId = new Map<string, string>();
      for (const r of tsRows) if (r.ts_created) tsByQitemId.set(r.qitem_id, r.ts_created);
      idsArr.sort((a, b) => {
        const tsA = tsByQitemId.get(a) ?? a;
        const tsB = tsByQitemId.get(b) ?? b;
        if (tsA === tsB) return 0;
        return tsA < tsB ? 1 : -1; // 降序。
      });
    } catch {
      // 排序失败（例如没有 ts_created 列）时回退为 qitem-id 字典序降序。
      // ID 格式编码了时间戳，因此实际仍是最新项优先。
      idsArr.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    }
    return idsArr;
  }

  /** qitem-ccf87c0d——构建或复用每代成员关系索引。每代只扫描两次 queue_items，
   *  取代 O(slices) 次逐切片扫描。
   *
   *  qitem-18110994 要求预先检查 schema，绝不从被吞掉的错误推断：
   *   - queue_items 不存在：发布一个带位置元数据（knownSlices/terms）的结构性空索引，
   *     保持 get/list 语义且不产生重建循环；
   *   - tags 列不存在：跳过类型化扫描，扫描 2 使用仅正文查询；
   *   - 任何 PRAGMA、类型化或回退执行失败都向调用方传播，且不发布任何内容。bucket
   *     在本地累积，只有完全成功才发布，故中断的构建绝不会缓存成貌似合理却不完整的答案。
   *
   *  扫描 1（类型化）：先用 `tags LIKE '%slice:%'` 预筛选，再按 ts_created DESC、
   *  qitem_id DESC 排序（保留 P2 确定性）；parseScopeTags 是权威逐行确认，每行计入它
   *  标记的所有切片；每个切片确认 500 条后截断，绝不在确认前 LIMIT（B2/VM-004）。
   *  此扫描覆盖所有位置，不受 `served` 限制。
   *  扫描 2（回退）：对已服务且无类型化记录的位置的术语全集，流式扫描一次 body/tags。
   *  list() 与打开的 withMembershipBatch 作用域覆盖所有这类位置；独立未缓存 get() 只覆盖一个。
   *  组合正则仅用于预筛选，随后仍逐行确认每个术语，使重叠术语都能记账，不受消费式 alternation
   *  影响。术语使用 SQL-LIKE 等价匹配（asciiFold 加 %/_ 转换）；bucket 按 rowid 顺序，
   *  与原先每术语无 ORDER BY 的 LIMIT 500 查询一致；每术语最多 500 条。
   *
   *  `served`（qitem-18110994 第 1 项）是当前公开操作的显式范围：实际回答的切片名集合，
   *  null 表示“所有已知位置”。它沿 get/list -> buildRecord/toListEntry -> matchQitems -> 此处
   *  的调用链传递，从不依赖环境状态。它只缩小 frontmatter 读取范围：locations、knownSlices、
   *  类型化扫描和覆盖所有位置的 typedMissions 判定都先建立，因此跨切片新旧规则保持逐字节一致
   *  （R5 差分）。 */
  private ensureMembershipIndex(served: Set<string> | null): MembershipIndex {
    // qitem-18f3300d——按操作而非 TTL 划定作用域：索引只存活于一次公开冷 list() 或
    // 一次未缓存 get() 期间（由公开入口清理），因此不同未缓存操作始终看到当前队列状态，
    // 新鲜度与父实现等价；单次冷列表内部仍共享一个批次。
    if (this.membershipIndex) {
      return this.membershipIndex;
    }

    const typedBySlice = new Map<string, string[]>();
    const fallbackTermsBySlice = new Map<string, string[]>();
    const fallbackByTerm = new Map<string, string[]>();
    const knownSlices = new Set<string>();

    // qitem-18110994（第 2、4 项）——先取得 schema 真相。显式检查 queue_items 形态，
    // 绝不从被吞掉的扫描错误推断。过去失败扫描会被记成“缺少 tags 列”，以错误结构标签
    // 静默降级成员关系。现在由 PRAGMA 回答结构问题，下方每个执行失败都继续向上传播。
    const columns = this.db.prepare(`PRAGMA table_info(queue_items)`).all() as Array<{ name: string }>;
    // 零列是唯一结构性降级：表不存在（测试环境未运行迁移）。成员关系在结构上为空，
    // 但仍发布带位置元数据的索引，使 get/list 保持现有语义且不产生重建循环。
    const tableAbsent = columns.length === 0;
    const tagsColumnPresent = columns.some((c) => c.name === "tags");

    // 先建立全局事实：locations 与 knownSlices 成本很低（仅遍历目录，不读文件），且必须
    // 不受作用域影响地覆盖每个位置；下方类型化扫描和任务级判定都依赖这些事实。
    const locations = this.readSliceLocations();
    for (const location of locations) knownSlices.add(location.name);

    // 扫描 1——类型化成员关系。仅当 schema 探针发现 tags 列时执行；缺列属于结构事实，
    // 直接跳过扫描，无需用 catch 探测。此处执行失败必须传播：它是真实故障而非形态事实，
    // 不能洗成“缺少 tags 列”的降级结果，也不能继续进行后续回退扫描。
    if (!tableAbsent && tagsColumnPresent) {
      const stmt = this.db.prepare(
        `SELECT qitem_id, tags FROM queue_items WHERE tags LIKE '%slice:%' ORDER BY ts_created DESC, qitem_id DESC`,
      );
      for (const r of stmt.iterate() as Iterable<{ qitem_id: string; tags: string | null }>) {
        if (this.projectId && !belongsToProject(r.tags, this.projectId)) continue;
        for (const tagged of parseScopeTags(r.tags).slices) {
          const bucket = typedBySlice.get(tagged);
          if (!bucket) typedBySlice.set(tagged, [r.qitem_id]);
          else if (bucket.length < 500) bucket.push(r.qitem_id);
        }
      }
    }

    // 扫描 2——为无类型化记录切片的可用术语全集建立回退 bucket。一个类型化同级切片会
    // 把任务标记为现代格式：其中无类型化记录的切片保留自己的名称和显式作者 rail，
    // 但省略 missionId 以及仅从 missionId 默认得到的 rail。没有类型化切片的旧任务保留
    // 完整的旧术语顺序。
    const typedMissions = new Set<string>();
    for (const location of locations) {
      if (location.missionId && (typedBySlice.get(location.name)?.length ?? 0) > 0) {
        typedMissions.add(location.missionId);
      }
    }
    // qitem-18110994（第 1 项）——frontmatter 只在这里读取，并且只读取实际可能使用
    // 回退术语的位置：当前操作服务且没有已确认类型化成员关系的位置。有类型化行的已服务
    // 切片直接从 typedBySlice 返回，从不触碰这些术语，故完全无需读取成员关系 frontmatter。
    // 可用性规则依赖的一切（locations、typedBySlice、覆盖所有位置的 typedMissions）都已在
    // 上方固定，因此缩小读取范围不会改变现代/旧版判定。
    //
    // 作者声明/default rail 的区别在构建术语的此处确定。它只影响现代任务，因为默认派生的
    // rail 就是 mission id，不能重新引入已被类型化同级成员关系禁用的任务级回退。
    const fallbackTerms = new Set<string>();
    for (const location of locations) {
      const slice = location.name;
      if (served !== null && !served.has(slice)) continue;
      const typed = typedBySlice.get(slice);
      if (typed && typed.length > 0) continue;
      const frontmatter = this.readPrimaryFrontmatter(location.slicePath);
      const railItem = this.extractRailItem(frontmatter, location.missionId);
      const explicitRailItem = this.extractExplicitRailItem(frontmatter);
      const modernMission = location.missionId !== null && typedMissions.has(location.missionId);
      const terms = Array.from(new Set(
        [
          slice,
          modernMission ? explicitRailItem : railItem,
          modernMission ? null : location.missionId,
        ].filter((v): v is string => !!v),
      ));
      fallbackTermsBySlice.set(slice, terms);
      for (const term of terms) fallbackTerms.add(term);
    }
    if (!tableAbsent && fallbackTerms.size > 0) {
      const termList = Array.from(fallbackTerms);
      const matchers = termList.map((term) => ({
        term,
        re: new RegExp(likeBoundPatternToRegExpSource(term), LIKE_REGEXP_FLAGS),
      }));
      const prefilter = new RegExp(matchers.map((m) => `(?:${m.re.source})`).join("|"), LIKE_REGEXP_FLAGS);
      // qitem-18110994（第 2 项）——bucket 在本地累积，只有扫描完成后才发布到索引。
      // 过去它们会预置到已发布 map，宽泛 catch 又允许把部分填充结果缓存为权威答案，
      // 于是中断构建会提供貌似合理却不完整的成员关系。现在执行失败会传播且不发布任何内容。
      const localBuckets = new Map<string, string[]>();
      for (const term of termList) localBuckets.set(term, []);
      const scan = tagsColumnPresent
        ? this.db.prepare(`SELECT qitem_id, body, tags FROM queue_items`)
        : this.db.prepare(`SELECT qitem_id, body FROM queue_items`);
      for (const r of scan.iterate() as Iterable<{ qitem_id: string; body: string; tags?: string | null }>) {
        if (this.projectId && !belongsToProject(r.tags, this.projectId)) continue;
        const hayBody = asciiFold(sqliteVisiblePrefix(r.body));
        const hayTags = r.tags != null ? asciiFold(sqliteVisiblePrefix(r.tags)) : null;
        if (!prefilter.test(hayBody) && !(hayTags !== null && prefilter.test(hayTags))) continue;
        for (const m of matchers) {
          if (m.re.test(hayBody) || (hayTags !== null && m.re.test(hayTags))) {
            const bucket = localBuckets.get(m.term)!;
            if (bucket.length < 500) bucket.push(r.qitem_id);
          }
        }
      }
      for (const [term, ids] of localBuckets) fallbackByTerm.set(term, ids);
    }

    this.membershipIndex = { typedBySlice, fallbackTermsBySlice, fallbackByTerm, knownSlices };
    return this.membershipIndex;
  }

  private findProofPacket(sliceName: string): SliceProofPacket | null {
    if (!this.dogfoodEvidenceRoot) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dogfoodEvidenceRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    // 匹配策略以 token 为单位：按 `-` 拆分切片名，丢弃末尾 `vN` 版本 token
    // （真实证明目录通常不含版本后缀）。若所有剩余 token 都作为连字符分隔的子串出现在
    // 目录名中，则视为匹配。这能处理真实目录把阶段标识放在前面（例如
    // `pl005-phase-a-mission-control-queue-observability-...`），而切片文件夹使用后缀形式
    //（`mission-control-queue-observability-phase-a`）的情况。最终选择 mtime 最新者。
    const sliceTokens = sliceName.split("-").filter((t) => t.length > 0 && !/^v\d+$/.test(t));
    const matches: { dirent: fs.Dirent; mtime: number }[] = [];
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const dirTokenSet = new Set(dirent.name.split(/[-._]/).filter((t) => t.length > 0));
      const allTokensPresent = sliceTokens.every((t) => dirTokenSet.has(t));
      if (!allTokensPresent) continue;
      try {
        const st = fs.statSync(path.join(this.dogfoodEvidenceRoot, dirent.name));
        matches.push({ dirent, mtime: st.mtimeMs });
      } catch {
        // 跳过不可读取项。
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.mtime - a.mtime);
    const winner = matches[0]!;
    const absPath = path.join(this.dogfoodEvidenceRoot, winner.dirent.name);
    return this.scanProofPacket(absPath, winner.dirent.name, winner.mtime);
  }

  private scanProofPacket(absPath: string, dirName: string, mtimeMs: number): SliceProofPacket {
    const markdownFiles: { rel: string; mtime: number }[] = [];
    const screenshots: string[] = [];
    const videos: string[] = [];
    const traces: string[] = [];

    const walk = (dir: string, relPrefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".md")) {
          try {
            const st = fs.statSync(full);
            markdownFiles.push({ rel, mtime: st.mtimeMs });
          } catch {
            markdownFiles.push({ rel, mtime: 0 });
          }
        } else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp")) {
          screenshots.push(rel);
        } else if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) {
          videos.push(rel);
        } else if (lower.endsWith(".zip") && rel.includes("trace")) {
          traces.push(rel);
        }
      }
    };

    walk(absPath, "");
    markdownFiles.sort((a, b) => b.mtime - a.mtime);

    return {
      dirName,
      absPath,
      markdownFiles: markdownFiles.map((m) => m.rel),
      screenshots: screenshots.sort(),
      videos: videos.sort(),
      traces: traces.sort(),
      mtime: new Date(mtimeMs).toISOString(),
    };
  }

  private computeLastActivity(slicePath: string, qitemIds: string[], proofPacket: SliceProofPacket | null): string | null {
    let maxMs = 0;
    try {
      const st = fs.statSync(slicePath);
      maxMs = Math.max(maxMs, st.mtimeMs);
    } catch {
      // ignore
    }
    if (qitemIds.length > 0) {
      try {
        const placeholders = qitemIds.map(() => "?").join(",");
        const row = this.db.prepare(
          `SELECT MAX(ts_updated) AS mx FROM queue_items WHERE qitem_id IN (${placeholders})`
        ).get(...qitemIds) as { mx: string | null } | undefined;
        if (row?.mx) {
          const ms = Date.parse(row.mx);
          if (!Number.isNaN(ms)) maxMs = Math.max(maxMs, ms);
        }
      } catch {
        // 忽略（queue_items 缺失）。
      }
    }
    if (proofPacket) {
      const ms = Date.parse(proofPacket.mtime);
      if (!Number.isNaN(ms)) maxMs = Math.max(maxMs, ms);
    }
    return maxMs > 0 ? new Date(maxMs).toISOString() : null;
  }

  private listSliceFiles(slicePath: string): string[] {
    try {
      return fs.readdirSync(slicePath, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }
}

// --- frontmatter 解析器（刻意保持最小，只实现轻量 YAML）---

export function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith(FRONTMATTER_DELIM)) return {};
  const rest = content.slice(FRONTMATTER_DELIM.length);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM}`);
  if (endIdx === -1) return {};
  const body = rest.slice(0, endIdx);
  const out: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // 移除包裹引号。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** V0.3.1 slice 13 walk-item 7——把 `workflow_spec: <name>@<version>`
 *  frontmatter 解析为结构化引用。值缺失、非字符串或不符合
 *  `<name>@<version>` 结构时返回 null。导出后，missions 路由可在任务目标 README
 *  的 frontmatter 上复用同一解析器。 */
/**
 * OPR.0.3.2.17 —— 从切片 frontmatter 提取简短描述。先尝试 `description`，再尝试
 * `summary`。二者均缺失或不是字符串时返回 null。去除首尾空白；空字符串转为
 * null，以触发适配器的平稳空值回退。
 */
export function extractDescription(frontmatter: Record<string, unknown>): string | null {
  for (const key of ["description", "summary"]) {
    const v = frontmatter[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

export function parseWorkflowSpecRef(raw: unknown): WorkflowSpecRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;
  const name = trimmed.slice(0, atIdx).trim();
  const version = trimmed.slice(atIdx + 1).trim();
  if (!name || !version) return null;
  return { name, version };
}
