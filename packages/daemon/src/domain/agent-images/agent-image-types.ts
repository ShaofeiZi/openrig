// Fork 原语 + Starter 智能体镜像 v0（PL-016）——与 skills、workflow_specs、
// context_packs（PL-014）并列的类型化原语。
//
// agent_image 是生产性席位可恢复状态的快照包——包含运行时专用恢复 token
//（Claude resume_token / Codex thread_id）、源席位谱系以及可选 cwd 增量与说明。
// 它会展示在 Specs 库中，并可由 AgentSpec 使用：
// `session_source: mode: agent_image, ref: { kind: image_name, ... }`.
// 存储位置为 ~/.openrig/agent-images/<name>/ 与工作区本地的
// .openrig/agent-images/<name>/。
//
// MVP 单主机场景以文件系统为规范来源，不新增 SQLite 表；库缓存在后台服务范围内存中。

export type AgentImageRuntime = "claude-code" | "codex";

export interface AgentImageManifest {
  name: string;
  version: string;
  runtime: AgentImageRuntime;
  /** 源席位的规范会话名，例如 "velocity-driver@openrig-velocity"。 */
  sourceSeat: string;
  /** 创建快照时捕获的原生对话 ID。Claude 使用 sessions 表中的 resume_token；
   *  Codex 使用 codex-thread-id.ts 提供的 thread_id。 */
  sourceSessionId: string;
  /** v0 中与 sourceSessionId 相同。清单仍保留独立字段，使未来版本可拆分
   *  运行时对话身份与运行时恢复 token，同时不破坏旧清单。 */
  sourceResumeToken: string;
  /** PL-016 source-cwd 行为：创建快照时解析出的源席位 cwd。记录该值后，
   *  “用作 starter”片段可输出 `cwd: <source_cwd>`，使派生会话从父会话创建时的
   *  同一目录启动；Claude 按项目目录限定的会话存储因此能够找到其中的 jsonl 文件。
   *  后台服务在派生调度时不会覆盖 cwd；如果操作员手动修改 rig.yaml 中的 cwd，
   *  派生会如实失败并提示 "no conversation found"。该字段可选：在支持 source_cwd
   *  之前生成的清单会省略它，片段也会为向后兼容而不渲染 cwd 行。 */
  sourceCwd?: string;
  createdAt: string;
  notes?: string;
  /** 可选补充文件（类似 context_pack 文件）。v0 除透传外没有此表面的消费者；
   *  v0+1 触发器具名引用后，启动编排器会在启动时将其组合进席位 cwd。 */
  files: AgentImageManifestFile[];
  /** 操作员提供或捕获器推导的估算值，用于库中的概览展示；库服务还会根据
   *  磁盘实际内容大小计算 derivedEstimatedTokens。 */
  estimatedTokens?: number;
  /** 镜像从另一个镜像派生时填充的谱系链；创建镜像时可记录
   *  `lineage: [<parent>, ...]`。 */
  lineage?: string[];
}

export interface AgentImageManifestFile {
  path: string;
  role: string;
  summary?: string;
}

export interface AgentImageStats {
  /** 镜像被消费时原子递增；消费来源可以是 rig fork / agent-image fork，
   *  也可以是实例化阶段的 `session_source: mode: agent_image` 消费者。 */
  forkCount: number;
  /** 最近一次消费的 ISO 时间戳。 */
  lastUsedAt: string | null;
  /** 后台服务推导的镜像目录总字节数估算（清单 + 补充文件）。 */
  estimatedSizeBytes: number;
  /** 完整解析的谱系链（镜像 manifest.lineage）。该值保留在 stats 中，
   *  使父镜像重命名时能够独立更新。 */
  lineage: string[];
}

export type AgentImageSourceType = "user_file" | "workspace" | "builtin";

export interface AgentImageEntry {
  /** 与 context-pack: 并列的稳定 ID：`agent-image:<name>:<version>`。 */
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: AgentImageRuntime;
  sourceSeat: string;
  sourceSessionId: string;
  /** 创建快照时源席位的 cwd。清单早于 source_cwd 支持时为 null
   *  （向后兼容表面）；由“用作 starter”片段生成器消费。 */
  sourceCwd: string | null;
  notes: string | null;
  createdAt: string;
  sourceType: AgentImageSourceType;
  /** 镜像目录的绝对路径。 */
  sourcePath: string;
  /** 相对于发现该镜像之根目录的路径。 */
  relativePath: string;
  /** 镜像目录下最新的 mtime。 */
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: AgentImageEntryFile[];
  /** 恢复 token 表面与清单数据分开保存，使 library/list/get 路由在操作员浏览时
   *  可以省略它，而在实例化器消费时可以包含它。 */
  sourceResumeToken: string;
  stats: AgentImageStats;
  lineage: string[];
  /** <sourcePath>/.pinned 中存在显式 `pin` 文件时为 true。无论活动引用扫描结果如何，
   *  已固定镜像都不会被 `prune`。 */
  pinned: boolean;
}

export interface AgentImageEntryFile {
  path: string;
  role: string;
  summary: string | null;
  absolutePath: string | null;
  bytes: number | null;
  estimatedTokens: number | null;
}

export class AgentImageError extends Error {
  constructor(
    public readonly code:
      | "manifest_missing"
      | "manifest_parse_error"
      | "manifest_invalid"
      | "image_not_found"
      | "image_referenced"
      | "image_pinned"
      | "runtime_mismatch"
      | "stats_write_failed",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentImageError";
  }
}
