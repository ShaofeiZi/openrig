import type { Binding, StartupFile } from "./types.js";
import type { ProjectionPlan } from "./projection-planner.js";

// -- 桥接类型：NodeBinding 在 Binding 上增加 cwd --
// 仓库过渡类型。当前 types.ts 中只有 Binding；启动编排器（AS-T07）根据 Binding + node.cwd
// 构造 NodeBinding。

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 接缝 B：从席位 permission_policy 附件解析出的启动姿态。优先级为
   * member > rig，由核心解析器在物化/恢复时解析。缺失表示未附加策略，继续使用环境变量驱动的
   * floor/YOLO 决策；存在则为该席位的权威值，会双向覆盖环境变量读取。 */
  launchPosture?: "floor" | "full_bypass";
  /** 显式 Claude 原生模式；会对照绑定的托管可执行文件校验。 */
  permissionMode?: string;
  /** 预留的后继 generation；提交前，当前任期仍作为输入围栏。 */
  launchGeneration?: string;
  /** #25：工作组的 `managed_blocks.claude-code` 文件；缺失时使用 CLAUDE.md。仅 Claude 适配器读取。 */
  claudeManagedBlockFile?: import("./managed-blocks.js").ClaudeManagedBlockFile;
}

// -- 带源根目录来源信息的已解析启动文件 --

export interface ResolvedStartupFile {
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
  /** 可选判别字段；启动产物仅支持文件。 */
  kind?: "file";
}

// -- 适配器结果类型 --

export interface InstalledResource {
  effectiveId: string;
  category: string;
  installedPath: string;
}

export interface ProjectionResult {
  projected: string[];
  skipped: string[];
  failed: Array<{ effectiveId: string; error: string }>;
}

export interface StartupDeliveryResult {
  delivered: number;
  failed: Array<{ path: string; error: string }>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  code?: string;
}

export const ATTENTION_REQUIRED_READINESS_CODES = new Set([
  "trust_gate",
  "hook_trust_gate",
  "update_gate",
  "login_required",
  "mcp_gate",
  // Codex 认证拒绝（已存 OAuth token 无法再刷新）。防御性处理：第 6 行的 verifyResumeLaunch
  // 补丁会沿启动路径传播 attention_required，因此就绪回退通常看不到此 code；在此加入可让
  // 两条路径保持语义一致。
  "codex_auth_refusal",
  "codex_client_incompatible",
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

// -- Harness 启动结果 --

export type HarnessLaunchRecovery = "retry_fresh" | "attention_required";

export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: import("./permission-drift.js").AppliedLaunchObservation }
  // 对 `attention_required` 结果，`evidence` 携带窗格最后 N 行，使失败可以通过
  // RestoreNodeResult.attentionEvidence 传递真实证据；非待关注恢复时省略。
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence?: string };

// -- 共享的具体提示解析器 --

/**
 * 将 'auto' 交付提示解析为具体提示。它是启动分区和适配器交付共用的唯一事实源，
 * 规则与既有适配器逻辑逐字节一致。
 */
export function resolveConcreteHint(
  path: string,
  content: string,
): "guidance_merge" | "skill_install" | "send_text" {
  if (path.endsWith("SKILL.md") || content.startsWith("# SKILL")) return "skill_install";
  if (path.endsWith(".md")) return "guidance_merge";
  return "send_text";
}

// -- 运行时适配器契约 --

/**
 * 成员级 fork 源输入，由启动编排器从 rigspec 成员的 `sessionSource` 字段转换。v1 的精简
 * MVP 仅支持 kind="native_id"；其他结构目前会在 schema 校验阶段被拒绝。
 *
 * 支持 fork 的适配器（claude-code、codex）根据此输入构造各自的 fork 命令，并捕获 fork 后
 * 的新 token，绝不使用父 token。不支持 fork 的适配器（terminal）会以明确的运行时不匹配
 * 错误拒绝。
 */
export interface ForkSource {
  kind: "native_id" | "artifact_path" | "name" | "last";
  value?: string;
}

/**
 * 包含五个方法的运行时适配器契约。适配器负责投影、交付、harness 启动、对账和就绪检查。
 * 启动动作执行不属于此契约，它由启动编排器在 checkReady() 后负责。
 */
export interface RuntimeAdapter {
  /** Claude 托管能力/启动接缝，与席位选择共享。 */
  readonly claudeManagedLaunch?: import("./claude-managed-launch.js").ClaudeManagedLaunch;
  readonly runtime: string;

  /** 列出节点当前已安装/投影的资源。 */
  listInstalled(binding: NodeBinding): Promise<InstalledResource[]>;

  /** 按投影计划将资源投影到运行时目标位置。 */
  project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult>;

  /** 向运行时交付启动文件。 */
  deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult>;

  /**
   * 在 tmux 会话内启动 harness（claude/codex/terminal）。
   *
   * `resumeToken` 与 `forkSource` 互斥。两者同时提供时，适配器必须以明确错误拒绝，不能
   * 猜测。`forkSource` 从指定来源触发 fork；结果中捕获的 resumeToken 是 fork 后的新 token，
   * 绝不是父 token。
   */
  launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult>;

  /** 检查运行时 harness 是否响应且已就绪。 */
  checkReady(binding: NodeBinding): Promise<ReadinessResult>;
}
