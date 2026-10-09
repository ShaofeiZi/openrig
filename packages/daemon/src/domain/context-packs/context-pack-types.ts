// 工作组上下文 / 可组合上下文注入 v0（PL-014）——类型化原语的共享类型。
//
// context_pack 是包含 `manifest.yaml` 及所引用 Markdown/YAML/TXT 文件的目录。它由操作员编写，
// 可被库发现、审查和发送；结构上与 skills、workflow_specs 并列。
//
// MVP 单主机上下文：文件系统是真源，存储在主机的 `<context.root>/<ref>/`
//（默认为 `$OPENRIG_HOME/context`）及工作区本地的 `.openrig/context-packs/<name>/`。
// 不新增 SQLite 表；库缓存在后台服务范围内保存在内存中。

export interface ContextPackManifestFile {
  /** pack 目录内的相对路径。 */
  path: string;
  /** 操作员自定义的自由格式角色（例如 `prd`、`proof-packet`、`architecture-brief`）；
   *  若形成稳定模式，可在 v1+ 收敛为封闭枚举。 */
  role: string;
  /** 在审查窗格和 bundle 框架中显示的单行说明。 */
  summary?: string;
}

// OPR.0.5.3.5 mini-req 1——atom schema 使用的创始人分类法与世界结构
//（设计上下文见 SPEC.md；输入见 DESIGN-INTAKE-ATOM-SCHEMA）。OPR.0.5.6.10 在 PACK 层级
// 将同一枚举提升为一等定义：每份 manifest 都通过此唯一声明点回答“我是哪类上下文”。
export const ATOM_TAXONOMIES = ["world", "lore", "skills", "mission"] as const;

/** OPR.0.5.6.10 mini-req 2——所有拒绝界面（后台服务解析器、CLI 安装校验器）共享的分类说明：
 *  列出合法值，并按最初定义分别用一句话解释其含义。 */
export const TAXONOMY_TEACHING =
  `合法值：${ATOM_TAXONOMIES.join(" | ")}。` +
  "world = 你所在的环境，包括实体、规则和可用能力；" +
  "lore = 在此处积累的知识，即就地获得的位置知识；" +
  "skills = 你知道如何完成的事情，即程序性能力；" +
  "mission = 你当前正在做的事情，包括当前工作及其意图。" +
  "请在 manifest.yaml 中添加一行，例如 `taxonomy: skills`。";
export const ATOM_REGIONS = ["identity", "ontology", "terrain", "actors", "laws", "history", "state", "affordances"] as const;
export const ATOM_SITUATIONS = ["fresh", "handover", "post-compaction"] as const;
export const ATOM_PURPOSES = ["depth", "width"] as const;
export const ATOM_RUNTIMES = ["claude", "codex", "any"] as const;
export const ATOM_PRIORITIES = ["core", "recommended", "optional"] as const;
export const CONTEXT_PROFILE_RUNTIMES = ["claude", "codex"] as const;
export const CONTEXT_PROFILE_SOURCES = ["project", "mission", "seat", "slice"] as const;

/** 安装 ATOM（OPR.0.5.3.5 mini-req 1）：由地址与组合元数据构成，绝不是新文件。
 *  fresh/handover/post-compaction 都把地址组合成同一份字节，因此从结构上满足 mini-req 5，
 *  不会出现可漂移的第二份副本。Token 数量在组合时派生，绝不存储在这里
 *  （遵循“波动性 × 后果”规则）。 */
export interface ContextPackAtom {
  /** 稳定 slug，作为 order/requires/probes 的关联键。 */
  id: string;
  /** `file` 或 `file#H2-slug/H3-slug`（Atom-1 语法）；文件必须已在 manifest 中声明，
   *  使用标题路径时必须指向 Markdown 文件。 */
  address: string;
  taxonomy: (typeof ATOM_TAXONOMIES)[number];
  /** 世界结构标签，用于按区域组合；实测的 post-compaction 需求是宽度：affordances + terrain。 */
  regions?: Array<(typeof ATOM_REGIONS)[number]>;
  /** 组合代数的选择器；不得为空。 */
  situations: Array<(typeof ATOM_SITUATIONS)[number]>;
  purpose: (typeof ATOM_PURPOSES)[number];
  /** Mini-req 3：绝不假设不同运行时的 compaction 损失相同；默认为 `any`。 */
  runtime: (typeof ATOM_RUNTIMES)[number];
  /** 在基础遍历中的位置；吸收效果取决于顺序。 */
  order: number;
  /** 依赖边；子集 profile 必须包含其依赖闭包。只能引用已声明 ID，禁止自引用和环。 */
  requires?: string[];
  /** Token 预算受限时最先丢弃的内容（mini-req 9）。 */
  priority: (typeof ATOM_PRIORITIES)[number];
  /** 仅供具名 profile 使用的 atom 不加入旧版 situation profile。这样 coverage map 可以指向
   *  canonical source graph，而不会让 map 本身成为另一份默认预加载。 */
  profileOnly?: boolean;
  /** Mini-req 2：验收目标是行为发生变化，由自然语言 prompt 与预期可观察行为组成。Q3 bridge：
   *  此结构与 harness 的 EvalCase 对齐，可选的可编译 expectedPatterns 用于确定性校验，1-5 rubric
   *  用于评判式校验；`expect` 仍是必填的文字契约。输入时采用封闭 key 集。 */
  probe?: { prompt: string; expect: string; expectedPatterns?: string[]; rubric?: string };
}

/** 一个显式投递阶段。Atom 阶段选择 pack 已拥有的字节；context 阶段插入已配置的
 * project/mission/seat/task 来源，但不会把这些权威来源复制进 pack。 */
export interface ContextPackProfilePhase {
  id: string;
  atoms?: string[];
  context?: Array<(typeof CONTEXT_PROFILE_SOURCES)[number]>;
}

/** 针对一个 pack atom graph 的具名、可检查选择与顺序。runtime 只用于适用性检查，
 * 不是新的内容来源。 */
export interface ContextPackProfile {
  id: string;
  situations: Array<(typeof ATOM_SITUATIONS)[number]>;
  runtimes: Array<(typeof CONTEXT_PROFILE_RUNTIMES)[number]>;
  phases: ContextPackProfilePhase[];
}

export interface ContextPackManifest {
  name: string;
  version: string;
  purpose?: string;
  /** OPR.0.5.6.10 mini-req 1——来自共享枚举的必填 pack 级分类。它对整个 pack 分类；
   *  atom 级 taxonomy 仍是各 atom 的权威值，并且不同 atom 可以不同（mini-req 5）。 */
  taxonomy: (typeof ATOM_TAXONOMIES)[number];
  files: ContextPackManifestFile[];
  /** 操作员提供的估算值，在没有逐文件估算时作为提示；库服务会根据实际文件大小计算
   *  `derivedEstimatedTokens` 用于显示。 */
  estimatedTokens?: number;
  /** OPR.0.5.3.5 mini-req 1——带组合元数据的安装 atom。 */
  atoms?: ContextPackAtom[];
  /** 可选的具名安装 profile。省略时精确保留旧版 situation/runtime 组合行为。 */
  profiles?: ContextPackProfile[];
}

export type ContextPackSourceType = "builtin" | "user_file" | "workspace";

/** `ContextPackLibraryService` 生成的库记录。 */
export interface ContextPackEntry {
  /** 用于路由和 UI 导航的稳定标识符：
   *  `context-pack:<name>:<version>`. */
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  /** OPR.0.5.6.10 mini-req 4——pack 分类；投影后会在列表中显示
   *  （人类可读列及 `--json` 字段）。 */
  taxonomy: (typeof ATOM_TAXONOMIES)[number];
  sourceType: ContextPackSourceType;
  /** pack 目录的绝对路径。 */
  sourcePath: string;
  /** 相对于发现此 pack 的 discovery root 的路径。 */
  relativePath: string;
  /** pack 目录中最新 mtime 的 ISO 时间戳；取 manifest.yaml 与所有引用文件中的较新值。 */
  updatedAt: string;
  /** manifest 中由操作员提供的估算值；未提供时为 null。 */
  manifestEstimatedTokens: number | null;
  /** 后台服务根据实际文件大小派生的估算值，即字符数除以 4 后取整；
   *  与既有 context-usage 约定一致。 */
  derivedEstimatedTokens: number;
  /** 根据 manifest 与磁盘读取结果投影出的逐文件元数据。 */
  files: ContextPackEntryFile[];
}

export interface ContextPackEntryFile {
  path: string;
  role: string;
  summary: string | null;
  /** 文件在磁盘上的绝对路径；manifest 引用了不存在的文件时为 null。此时 entry 会如实显示
   *  `bytes=null`，而不是拒绝建立索引。 */
  absolutePath: string | null;
  /** 文件大小（字节）；文件缺失或不可读时为 null。 */
  bytes: number | null;
  /** 后台服务派生的逐文件 token 估算值，即字符数除以 4 后取整。 */
  estimatedTokens: number | null;
}

export class ContextPackError extends Error {
  constructor(
    public readonly code:
      | "manifest_missing"
      | "manifest_parse_error"
      | "manifest_invalid"
      | "pack_not_found"
      | "file_outside_pack"
      | "file_read_failed"
      // Slice-03 Atom 2：路径式 ref 在发现/解析边界未通过封闭的逐段契约（ref-safety.ts）。
      | "unsafe_ref"
      // Slice-03 Atom 3：持久文件组合边界。
      | "missing_files"
      | "pack_exists"
      | "pack_ref_below_pack"
      | "unsafe_ref_namespace"
      | "pack_write_failed"
      | "store_unavailable"
      // Slice-03 Atom 4：rm 拒绝删除随产品交付的 `builtin` pack；这与 add 的操作员可写契约对应，
      // 绝不会对 package 目录下的已交付 asset 执行 rmSync。
      | "pack_not_removable",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContextPackError";
  }
}
