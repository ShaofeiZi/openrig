import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ——共享类型——

/**
 * 出处块——bundle 产物的归属元数据。所有字段均可选以保持向后兼容；
 * 没有 provenance 的 bundle 仍按原样安装。由 bundle-assembler 在创建时捕获，
 * 显示在 inspect 输出和审计轨迹记录中。此阶段不做密码学签名。
 */
export interface BundleProvenance {
  /** ISO 时间戳；创建时与根 createdAt 一致。 */
  createdAt?: string;
  /** 执行 `zrig bundle create` 的主机 os.hostname()。 */
  sourceHost?: string;
  /** 创建者的规范会话名，例如 velocity-driver@openrig-velocity。 */
  authorSession?: string;
  /** 从实时工作组创建时的源工作组 ULID。 */
  sourceRigId?: string;
  /** 从实时工作组创建时的源工作组名称。 */
  sourceRigName?: string;
  /** 创建时的后台服务版本，例如 0.3.2。 */
  daemonVersion?: string;
  /** 创建时的 CLI 版本，例如 0.3.2。 */
  cliVersion?: string;
  /** 操作人员通过 `zrig bundle create --notes` 编写的备注。 */
  notes?: string;
}

const PROVENANCE_STRING_FIELDS = [
  "created_at",
  "source_host",
  "author_session",
  "source_rig_id",
  "source_rig_name",
  "daemon_version",
  "cli_version",
  "notes",
] as const;

/** 校验可选 provenance 块；若存在但畸形，则追加到 errors。 */
function validateProvenanceBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("provenance 必须是对象");
    return;
  }
  const p = raw as Record<string, unknown>;
  for (const field of PROVENANCE_STRING_FIELDS) {
    if (field in p && typeof p[field] !== "string") {
      errors.push(`provenance.${field} 必须是字符串`);
    }
  }
}

/** 将类型化 BundleProvenance 序列化为 snake_case YAML 记录形状。 */
function provenanceToYamlRecord(p: BundleProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.createdAt !== undefined) out["created_at"] = p.createdAt;
  if (p.sourceHost !== undefined) out["source_host"] = p.sourceHost;
  if (p.authorSession !== undefined) out["author_session"] = p.authorSession;
  if (p.sourceRigId !== undefined) out["source_rig_id"] = p.sourceRigId;
  if (p.sourceRigName !== undefined) out["source_rig_name"] = p.sourceRigName;
  if (p.daemonVersion !== undefined) out["daemon_version"] = p.daemonVersion;
  if (p.cliVersion !== undefined) out["cli_version"] = p.cliVersion;
  if (p.notes !== undefined) out["notes"] = p.notes;
  return out;
}

/**
 * 跨原语打包——第 6 项 / slice-05 Checkpoint 7.1。
 *
 * Manifest 可选择声明带类型的同级原语，bundle 安装时应将它们路由到各自的库。
 * v0 交付 `skills` 种类（Checkpoint 7.1）；随着对应库可达，plugins、workflow_specs、
 * context_packs 和 agent_images 在后续 checkpoint 中增量落地。
 *
 * PRD 第 6 项：bundle 将它们与现有 rig、agents、packages 字段并列；不以 `contents:`
 * 重新分组，因为那会重组 schema，违反不升版约束。每种内容都是可选顶层字段；
 * 缺失种类保持向后兼容。
 */

/**
 * 插件引用——第 6 项 / slice-05 Checkpoint 7.3b。bundle manifest 可声明其包含的
 * plugin 引用；按 orch 批准的决策文档，HYBRID 模式下 bundle 引用现有 0.3.1 plugin，
 * 而不是分叉其内容。
 */
export interface BundlePluginReference {
  /** plugin id，与 plugin 原语的 id 表面一致。 */
  id: string;
  /** plugin 的解析来源。v0 支持本地路径来源。 */
  source: { kind: "local"; path: string };
}

/** 校验可选 plugins[] 块；若存在但畸形，则追加到 errors。 */
function validatePluginsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("plugins 必须是数组");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`plugins[${i}] 必须是对象`);
      continue;
    }
    const p = entry as Record<string, unknown>;
    if (typeof p["id"] !== "string" || !p["id"]) {
      errors.push(`plugins[${i}].id 为必填项`);
    }
    const source = p["source"];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      errors.push(`plugins[${i}].source 必须是对象`);
      continue;
    }
    const s = source as Record<string, unknown>;
    if (s["kind"] !== "local") {
      errors.push(`plugins[${i}].source.kind 必须为 'local'（其他种类留待以后）`);
    }
    if (typeof s["path"] !== "string" || !s["path"]) {
      errors.push(`plugins[${i}].source.path 为必填项`);
    } else if (!isRelativeSafePath(s["path"] as string)) {
      errors.push(`plugins[${i}].source.path 不安全：'${s["path"]}'`);
    }
  }
}

/** 归一化原始 plugins[] 块（防御性复制）。 */
function normalizePluginsBlock(raw: unknown): BundlePluginReference[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: BundlePluginReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const p = entry as Record<string, unknown>;
    const s = p["source"];
    if (typeof p["id"] !== "string" || !p["id"]) continue;
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const src = s as Record<string, unknown>;
    if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
    result.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
  }
  return result.length > 0 ? result : undefined;
}

/** 校验可选 skills[] 块；若存在但畸形，则追加到 errors。 */
function validateSkillsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("skills 必须是数组");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`skills[${i}] 必须是字符串`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`skills[${i}] 路径不安全：'${entry}'`);
    }
  }
}

/** 归一化原始 skills[] 块（防御性复制 + 字符串过滤）。 */
function normalizeSkillsBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** 校验可选 workflow_specs[] 块；若存在但畸形，则追加到 errors。
 * 第 6 项 / slice-05 Checkpoint 7.3e。形状与 skills[] 相同：bundle 内 workflow spec
 * YAML 文件的相对安全路径数组。 */
function validateWorkflowSpecsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("workflow_specs 必须是数组");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`workflow_specs[${i}] 必须是字符串`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`workflow_specs[${i}] 路径不安全：'${entry}'`);
    }
  }
}

/** 归一化原始 workflow_specs[] 块（防御性复制 + 字符串过滤）。 */
function normalizeWorkflowSpecsBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** 校验可选 context_packs[] 块。第 6 项 / slice-05 Checkpoint 7.3f。
 * 每项都是 bundle 内 context pack 的 manifest.yaml 相对安全路径（按 PRD 第 6 项）。
 * 安装时 router 将每个 manifest 路径的父目录复制到操作人员 context-packs 库。 */
function validateContextPacksBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("context_packs 必须是数组");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`context_packs[${i}] 必须是字符串`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`context_packs[${i}] 路径不安全：'${entry}'`);
    }
  }
}

/** 归一化原始 context_packs[] 块（防御性复制 + 字符串过滤）。 */
function normalizeContextPacksBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** 校验可选 agent_images[] 块。第 6 项 / slice-05 Checkpoint 7.3g。
 * 每项都是 bundle 内 agent-image 目录的相对安全路径（PRD 第 6 项第 197 行：
 * agent_images: [path/to/agent-image-name/, ...]）。安装时 router 将声明的目录本身
 * 复制到操作人员 agent-images 库。消费者 agent-image-library-service.ts:77-95 要求
 * 每个路由后的镜像目录内存在 manifest.yaml；router 在复制时强制该约束。 */
function validateAgentImagesBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("agent_images 必须是数组");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`agent_images[${i}] 必须是字符串`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`agent_images[${i}] 路径不安全：'${entry}'`);
    }
  }
}

/** 归一化原始 agent_images[] 块（防御性复制 + 字符串过滤）。 */
function normalizeAgentImagesBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * 兼容性块——操作人员为 bundle 产物声明的安装时要求。所有字段可选；缺失该块时
 * 保持向后兼容，bundle 安装行为不变。安装时版本检查（第 2 项 Checkpoint 3.3）
 * 在委托 bootstrap 前查询此块；--skip-version-check 是操作人员显式覆盖。
 */
export interface BundleCompatibility {
  /** 安装此 bundle 所需的最低后台服务版本（semver 字符串）。 */
  minDaemonVersion?: string;
  /** 安装此 bundle 所需的最低 CLI 版本（semver 字符串）。 */
  minCliVersion?: string;
  /** 再次确认的 schema 版本；设置时镜像根 schemaVersion。 */
  schemaVersion?: number;
}

/** 校验可选 compatibility 块；若存在但畸形，则追加到 errors。 */
function validateCompatibilityBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("compatibility 必须是对象");
    return;
  }
  const c = raw as Record<string, unknown>;
  if ("min_daemon_version" in c && typeof c["min_daemon_version"] !== "string") {
    errors.push("compatibility.min_daemon_version 必须是字符串");
  }
  if ("min_cli_version" in c && typeof c["min_cli_version"] !== "string") {
    errors.push("compatibility.min_cli_version 必须是字符串");
  }
  if ("schema_version" in c && typeof c["schema_version"] !== "number") {
    errors.push("compatibility.schema_version 必须是数字");
  }
}

/** 将类型化 BundleCompatibility 序列化为 snake_case YAML 记录形状。 */
function compatibilityToYamlRecord(c: BundleCompatibility): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.minDaemonVersion !== undefined) out["min_daemon_version"] = c.minDaemonVersion;
  if (c.minCliVersion !== undefined) out["min_cli_version"] = c.minCliVersion;
  if (c.schemaVersion !== undefined) out["schema_version"] = c.schemaVersion;
  return out;
}

/**
 * 将原始 snake_case compatibility 归一化为类型化 camelCase BundleCompatibility。
 * 缺失或为空时返回 undefined。与 provenance 归一化器一同导出，使 v2 inspect-route
 * 投影能为两种 manifest schema 生成同一个 camelCase 形状。
 */
export function normalizeCompatibilityBlock(raw: unknown): BundleCompatibility | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const result: BundleCompatibility = {};
  if (typeof c["min_daemon_version"] === "string") result.minDaemonVersion = c["min_daemon_version"];
  if (typeof c["min_cli_version"] === "string") result.minCliVersion = c["min_cli_version"];
  if (typeof c["schema_version"] === "number") result.schemaVersion = c["schema_version"];
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 将从 YAML 解析或请求体接收的原始 snake_case provenance 归一化为类型化
 * camelCase BundleProvenance。缺失或为空时返回 undefined。导出此函数，使 v1
 * 归一化管线与 v2 inspect-route 投影生成相同 camelCase 形状——无论 schema 版本如何，
 * /api/bundles/inspect 都只有一种契约形状。
 */
export function normalizeProvenanceBlock(raw: unknown): BundleProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const result: BundleProvenance = {};
  if (typeof p["created_at"] === "string") result.createdAt = p["created_at"];
  if (typeof p["source_host"] === "string") result.sourceHost = p["source_host"];
  if (typeof p["author_session"] === "string") result.authorSession = p["author_session"];
  if (typeof p["source_rig_id"] === "string") result.sourceRigId = p["source_rig_id"];
  if (typeof p["source_rig_name"] === "string") result.sourceRigName = p["source_rig_name"];
  if (typeof p["daemon_version"] === "string") result.daemonVersion = p["daemon_version"];
  if (typeof p["cli_version"] === "string") result.cliVersion = p["cli_version"];
  if (typeof p["notes"] === "string") result.notes = p["notes"];
  return Object.keys(result).length > 0 ? result : undefined;
}

// ——Pod 感知 bundle 类型（AgentSpec 重启）——

export interface PodBundleAgentImportEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
}

export interface PodBundleAgentEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
  importEntries: PodBundleAgentImportEntry[];
}

export interface PodBundleManifest {
  schemaVersion: 2;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  agents: PodBundleAgentEntry[];
  cultureFile?: string;
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
  compatibility?: BundleCompatibility;
  /** 第 6 项跨原语打包：安装时路由到操作人员 skills 库的 skill 路径。 */
  skills?: string[];
  /** 第 6 项跨原语打包：经 plugin 原语安装的 plugin 引用；HYBRID 模式引用现有 plugin 而不分叉内容。 */
  plugins?: BundlePluginReference[];
  /** 第 6 项跨原语打包：安装时路由到操作人员 workflow-specs 库的 workflow spec YAML 路径（Checkpoint 7.3e）。 */
  workflowSpecs?: string[];
  /** 第 6 项跨原语打包：context-pack manifest.yaml 路径；安装时 router 将父目录复制到操作人员 context-packs 库（Checkpoint 7.3f）。 */
  contextPacks?: string[];
  /** 第 6 项跨原语打包：agent-image 目录路径；安装时 router 将目录复制到操作人员 agent-images 库，且每个镜像目录内必须有 manifest.yaml（Checkpoint 7.3g）。 */
  agentImages?: string[];
}

export function validatePodBundleManifest(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, errors: ["manifest 必须是对象"] };
  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 2) errors.push("schema_version 必须为 2");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name 为必填项");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version 为必填项");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at 为必填项");
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) errors.push("rig_spec 路径为必填项");
  else if (!isRelativeSafePath(m["rig_spec"] as string)) errors.push(`rig_spec 路径不安全：'${m["rig_spec"]}'`);

  if (!Array.isArray(m["agents"])) {
    errors.push("agents 必须是数组");
  } else {
    for (let i = 0; i < m["agents"].length; i++) {
      const a = m["agents"][i] as Record<string, unknown>;
      if (typeof a["name"] !== "string" || !a["name"]) errors.push(`agents[${i}].name 为必填项`);
      if (typeof a["path"] !== "string" || !a["path"]) errors.push(`agents[${i}].path 为必填项`);
      else if (!isRelativeSafePath(a["path"] as string)) errors.push(`agents[${i}].path 不安全`);
      if (typeof a["hash"] !== "string" || !a["hash"]) errors.push(`agents[${i}].hash 为必填项`);
    }
  }

  validateProvenanceBlock(m["provenance"], errors);
  validateCompatibilityBlock(m["compatibility"], errors);
  validateSkillsBlock(m["skills"], errors);
  validatePluginsBlock(m["plugins"], errors);
  validateWorkflowSpecsBlock(m["workflow_specs"], errors);
  validateContextPacksBlock(m["context_packs"], errors);
  validateAgentImagesBlock(m["agent_images"], errors);

  return { valid: errors.length === 0, errors };
}

export function serializePodBundleManifest(manifest: PodBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: 2,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    agents: manifest.agents.map((a) => ({
      name: a.name,
      version: a.version,
      path: a.path,
      original_ref: a.originalRef,
      hash: a.hash,
      import_entries: a.importEntries.map((ie) => ({
        name: ie.name,
        version: ie.version,
        path: ie.path,
        original_ref: ie.originalRef,
        hash: ie.hash,
      })),
    })),
  };
  if (manifest.cultureFile) doc["culture_file"] = manifest.cultureFile;
  if (manifest.integrity) doc["integrity"] = { algorithm: manifest.integrity.algorithm, files: manifest.integrity.files };
  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);
  if (manifest.compatibility) doc["compatibility"] = compatibilityToYamlRecord(manifest.compatibility);
  if (manifest.skills && manifest.skills.length > 0) doc["skills"] = manifest.skills;
  if (manifest.plugins && manifest.plugins.length > 0) doc["plugins"] = manifest.plugins.map((p) => ({ id: p.id, source: { kind: p.source.kind, path: p.source.path } }));
  if (manifest.workflowSpecs && manifest.workflowSpecs.length > 0) doc["workflow_specs"] = manifest.workflowSpecs;
  if (manifest.contextPacks && manifest.contextPacks.length > 0) doc["context_packs"] = manifest.contextPacks;
  if (manifest.agentImages && manifest.agentImages.length > 0) doc["agent_images"] = manifest.agentImages;
  return stringifyYaml(doc);
}

export function parsePodBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

// ——旧版 bundle 类型（重启前）——
// TODO：待 AS-T12 迁移全部消费者后移除。

/** 旧版 bundle manifest 中的 package 条目。 */
export interface LegacyBundlePackageEntry {
  name: string;
  version: string;
  path: string;
  originalSource: string;
  /** 从多个输入去重时的全部原始来源 ref。 */
  originalSources?: string[];
}

/** 带逐文件校验和的 integrity 区段。 */
export interface BundleIntegrity {
  algorithm: "sha256";
  files: Record<string, string>;
}

/** bundle.yaml 清单。 */
export interface LegacyBundleManifest {
  schemaVersion: number;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  packages: LegacyBundlePackageEntry[];
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
  compatibility?: BundleCompatibility;
  /** 第 6 项跨原语打包：安装时路由到操作人员 skills 库的 skill 路径。 */
  skills?: string[];
  /** 第 6 项跨原语打包：经 plugin 原语安装的 plugin 引用；HYBRID 模式引用现有 plugin 而不分叉内容。 */
  plugins?: BundlePluginReference[];
  /** 第 6 项跨原语打包：安装时路由到操作人员 workflow-specs 库的 workflow spec YAML 路径（Checkpoint 7.3e）。 */
  workflowSpecs?: string[];
  /** 第 6 项跨原语打包：context-pack manifest.yaml 路径；安装时 router 将父目录复制到操作人员 context-packs 库（Checkpoint 7.3f）。 */
  contextPacks?: string[];
  /** 第 6 项跨原语打包：agent-image 目录路径；安装时 router 将目录复制到操作人员 agent-images 库，且每个镜像目录内必须有 manifest.yaml（Checkpoint 7.3g）。 */
  agentImages?: string[];
}

/** 校验选项。 */
interface ValidateOptions {
  requireIntegrity?: boolean;
}

/**
 * 检查路径是否为安全的归档相对路径。拒绝绝对路径、../ 遍历、反斜杠、
 * 点路径段（./ 或裸 .）、空路径段（//）及空字符串。
 */
export function isRelativeSafePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** 校验原始解析后的 bundle manifest。 */
export function validateLegacyBundleManifest(
  raw: unknown,
  opts?: ValidateOptions,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requireIntegrity = opts?.requireIntegrity ?? true;

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest 必须是对象"] };
  }

  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 1) errors.push("schema_version 必须为 1");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name 为必填项");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version 为必填项");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at 为必填项");

  // rig_spec 路径。
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) {
    errors.push("rig_spec 路径为必填项");
  } else if (!isRelativeSafePath(m["rig_spec"] as string)) {
    errors.push(`rig_spec 路径不是安全的相对路径：'${m["rig_spec"]}'`);
  }

  // package 列表。
  if (!Array.isArray(m["packages"]) || m["packages"].length === 0) {
    errors.push("packages 必须是非空数组");
  } else {
    for (let i = 0; i < m["packages"].length; i++) {
      const pkg = m["packages"][i] as Record<string, unknown>;
      if (typeof pkg["name"] !== "string" || !pkg["name"]) errors.push(`packages[${i}].name 为必填项`);
      if (typeof pkg["version"] !== "string" || !pkg["version"]) errors.push(`packages[${i}].version 为必填项`);
      if (typeof pkg["path"] !== "string" || !pkg["path"]) {
        errors.push(`packages[${i}].path 为必填项`);
      } else if (!isRelativeSafePath(pkg["path"] as string)) {
        errors.push(`packages[${i}].path 不是安全的相对路径：'${pkg["path"]}'`);
      }
      if (typeof pkg["original_source"] !== "string" || !pkg["original_source"]) errors.push(`packages[${i}].original_source 为必填项`);
    }
  }

  // integrity：除非 requireIntegrity，否则可选。
  // integrity 校验：存在时始终校验结构；设置标志时要求必须存在。
  const hasIntegrity = m["integrity"] && typeof m["integrity"] === "object";
  if (requireIntegrity && !hasIntegrity) {
    errors.push("integrity 区段为必填项");
  }
  if (hasIntegrity) {
    const integrity = m["integrity"] as Record<string, unknown>;
    if (integrity["algorithm"] !== "sha256") errors.push("integrity.algorithm 必须为 'sha256'");
    if (!integrity["files"] || typeof integrity["files"] !== "object" || Object.keys(integrity["files"] as object).length === 0) {
      errors.push("integrity.files 必须是非空对象");
    } else {
      const files = integrity["files"] as Record<string, unknown>;
      for (const [key, value] of Object.entries(files)) {
        if (!isRelativeSafePath(key)) {
          errors.push(`integrity.files 键不是安全的相对路径：'${key}'`);
        }
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
          errors.push(`integrity.files['${key}'] 必须是 64 字符十六进制 SHA-256 哈希`);
        }
      }
    }
  }

  validateProvenanceBlock(m["provenance"], errors);
  validateCompatibilityBlock(m["compatibility"], errors);
  validateSkillsBlock(m["skills"], errors);
  validatePluginsBlock(m["plugins"], errors);
  validateWorkflowSpecsBlock(m["workflow_specs"], errors);
  validateContextPacksBlock(m["context_packs"], errors);
  validateAgentImagesBlock(m["agent_images"], errors);

  return { valid: errors.length === 0, errors };
}

/** 将 bundle.yaml 的 YAML 字符串解析为 unknown。 */
export function parseLegacyBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

/** 将原始解析后的 manifest 归一化为类型化 LegacyBundleManifest。 */
export function normalizeLegacyBundleManifest(raw: unknown): LegacyBundleManifest {
  const m = raw as Record<string, unknown>;
  const pkgs = (m["packages"] as Array<Record<string, unknown>>).map((p) => {
    const entry: LegacyBundlePackageEntry = {
      name: p["name"] as string,
      version: p["version"] as string,
      path: p["path"] as string,
      originalSource: (p["original_source"] as string) ?? "",
    };
    if (Array.isArray(p["original_sources"])) {
      entry.originalSources = p["original_sources"] as string[];
    }
    return entry;
  });

  const result: LegacyBundleManifest = {
    schemaVersion: (m["schema_version"] as number) ?? 1,
    name: m["name"] as string,
    version: m["version"] as string,
    createdAt: (m["created_at"] as string) ?? new Date().toISOString(),
    rigSpec: m["rig_spec"] as string,
    packages: pkgs,
  };

  if (m["integrity"] && typeof m["integrity"] === "object") {
    const integ = m["integrity"] as Record<string, unknown>;
    result.integrity = {
      algorithm: "sha256",
      files: (integ["files"] as Record<string, string>) ?? {},
    };
  }

  const provenance = normalizeProvenanceBlock(m["provenance"]);
  if (provenance) result.provenance = provenance;

  const compatibility = normalizeCompatibilityBlock(m["compatibility"]);
  if (compatibility) result.compatibility = compatibility;

  const skills = normalizeSkillsBlock(m["skills"]);
  if (skills) result.skills = skills;

  const plugins = normalizePluginsBlock(m["plugins"]);
  if (plugins) result.plugins = plugins;

  const workflowSpecs = normalizeWorkflowSpecsBlock(m["workflow_specs"]);
  if (workflowSpecs) result.workflowSpecs = workflowSpecs;

  const contextPacks = normalizeContextPacksBlock(m["context_packs"]);
  if (contextPacks) result.contextPacks = contextPacks;

  const agentImages = normalizeAgentImagesBlock(m["agent_images"]);
  if (agentImages) result.agentImages = agentImages;

  return result;
}

/** 将 LegacyBundleManifest 序列化为 YAML。 */
export function serializeLegacyBundleManifest(manifest: LegacyBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    packages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path,
      original_source: p.originalSource,
      ...(p.originalSources && p.originalSources.length > 1 ? { original_sources: p.originalSources } : {}),
    })),
  };

  if (manifest.integrity) {
    doc["integrity"] = {
      algorithm: manifest.integrity.algorithm,
      files: manifest.integrity.files,
    };
  }

  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);

  if (manifest.compatibility) doc["compatibility"] = compatibilityToYamlRecord(manifest.compatibility);

  if (manifest.skills && manifest.skills.length > 0) doc["skills"] = manifest.skills;
  if (manifest.plugins && manifest.plugins.length > 0) doc["plugins"] = manifest.plugins.map((p) => ({ id: p.id, source: { kind: p.source.kind, path: p.source.path } }));
  if (manifest.workflowSpecs && manifest.workflowSpecs.length > 0) doc["workflow_specs"] = manifest.workflowSpecs;
  if (manifest.contextPacks && manifest.contextPacks.length > 0) doc["context_packs"] = manifest.contextPacks;
  if (manifest.agentImages && manifest.agentImages.length > 0) doc["agent_images"] = manifest.agentImages;

  return stringifyYaml(doc);
}
