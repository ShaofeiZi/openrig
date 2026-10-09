import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ExecFn } from "../adapters/tmux.js";
import type { LegacyRigSpec as RigSpec, PreflightResult, RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember } from "./types.js"; // TODO：AS-T08b —— 迁移到 pod 感知的 RigSpec
import { deriveSessionName, validateSessionName, validateSessionComponents, VIRTUAL_DOMAIN_TOKENS } from "./session-name.js";

const RUNTIME_COMMANDS: Record<string, string> = {
  "claude-code": "claude --version",
  "codex": "codex --version",
  "pi": "pi --version",
};

interface RigSpecPreflightDeps {
  rigRepo: RigRepository;
  tmuxAdapter: TmuxAdapter;
  exec: ExecFn;
  cmuxExec: ExecFn;
}

// TODO：AS-T12 —— 路由迁移完成后重命名为 LegacyRigSpecPreflight
export class RigSpecPreflight {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private tmuxAdapter: TmuxAdapter;
  private exec: ExecFn;
  private cmuxExec: ExecFn;

  constructor(deps: RigSpecPreflightDeps) {
    this.db = deps.rigRepo.db;
    this.rigRepo = deps.rigRepo;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.exec = deps.exec;
    this.cmuxExec = deps.cmuxExec;
  }

  async check(spec: RigSpec): Promise<PreflightResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 验证派生会话名称。
    for (const node of spec.nodes) {
      const sessionName = deriveSessionName(spec.name, node.id);
      if (!validateSessionName(sessionName)) {
        errors.push(`为节点 '${node.id}' 派生的会话名称 '${sessionName}' 无效`);
      }
    }

    // M1 A1 —— 保留工作组名称（保留 token 防线中的 RIG 槽位部分，主机槽位部分为
    // RESERVED_HOST_IDS）。来源是 A2 虚拟域封闭集合 VIRTUAL_DOMAIN_TOKENS，即唯一事实源：
    // 名为 `external` 的工作组会让 `<local>@external` 与虚拟域分类器产生歧义
    //（member=<local> 且 rig=external，或虚拟域引用）。后台服务会在创建门禁处拒绝。
    if ((VIRTUAL_DOMAIN_TOKENS as readonly string[]).includes(spec.name)) {
      errors.push(`工作组名称 '${spec.name}' 是保留的虚拟域 token：它会与 '<local>@${spec.name}' 分类规则冲突，请选择其他名称`);
    }

    // 工作组名称冲突。
    const existingRigs = this.rigRepo.listRigs();
    if (existingRigs.some((r) => r.name === spec.name)) {
      errors.push(`工作组名称 '${spec.name}' 已存在`);
    }

    // tmux 会话名称冲突。
    for (const node of spec.nodes) {
      const sessionName = deriveSessionName(spec.name, node.id);
      if (validateSessionName(sessionName)) {
        const exists = await this.tmuxAdapter.hasSession(sessionName);
        if (exists) {
          errors.push(`节点 '${node.id}' 的 tmux 会话 '${sessionName}' 已存在`);
        }
      }
    }

    // 检查 cwd 是否存在。
    for (const node of spec.nodes) {
      if (node.cwd) {
        if (!existsSync(node.cwd)) {
          errors.push(`节点 '${node.id}' 的 cwd '${node.cwd}' 不存在`);
        } else {
          try {
            if (!statSync(node.cwd).isDirectory()) {
              errors.push(`节点 '${node.id}' 的 cwd '${node.cwd}' 不是目录`);
            }
          } catch {
            errors.push(`无法访问节点 '${node.id}' 的 cwd '${node.cwd}'`);
          }
        }
      }
    }

    // 检查运行时是否可用。
    const checkedRuntimes = new Set<string>();
    for (const node of spec.nodes) {
      if (checkedRuntimes.has(node.runtime)) continue;
      checkedRuntimes.add(node.runtime);

      const cmd = RUNTIME_COMMANDS[node.runtime];
      if (cmd) {
        try {
          await this.exec(cmd);
        } catch {
          errors.push(`运行时 '${node.runtime}' 不可用（${cmd} 执行失败）`);
        }
      }
    }

    // cmux 布局提示：spec 使用提示但 cmux 不可用时给出警告。
    const hasLayoutHints = spec.nodes.some((n) => n.surfaceHint || n.workspace);
    if (hasLayoutHints) {
      try {
        await this.cmuxExec("cmux capabilities --json");
      } catch {
        warnings.push("cmux 不可用，无法应用布局提示（surfaceHint/workspace）");
      }
    }

    return {
      ready: errors.length === 0,
      warnings,
      errors,
    };
  }
}

// -- 重启版工作组预检（AgentSpec reboot）--

import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig, type ResolutionContext } from "./profile-resolver.js";
import { getOpenRigInstallCwdError, resolveLaunchCwd } from "./cwd-resolution.js";
import nodePath from "node:path";
import { validateClaudeActivityHookDelivery, CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE } from "./claude-activity-hooks.js";
import {
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  type ResolvedPolicyAttachment,
} from "./permission-policy/policy-ref.js";

// Slice 51-01（OPR.0.5.1.1）：`stub` 是一等运行时（通过真实编排器运行确定性的 Node 脚本
// 假运行环境），在现代 pod 预检门禁中与真实运行时一同准入。
const SUPPORTED_RUNTIMES = new Set(["claude-code", "codex", "pi", "terminal", "stub"]);

// 后台服务随附的受管 Claude 活动 hook 默认资源路径，与 startup.ts 为 ClaudeCodeAdapter
// 装配的是同一组文件；两条路径都使用共享验证模块。测试可通过
// PreflightSpecContext.claudeActivityAssets 注入 fixture 并覆盖路径。
const DEFAULT_ACTIVITY_RELAY_PATH = nodePath.resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const DEFAULT_CLAUDE_HOOKS_MANIFEST_PATH = nodePath.resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/claude.json");

export interface RigPreflightInput {
  rigSpecYaml: string;
  rigRoot: string;
  cwdOverride?: string;
  fsOps: AgentResolverFsOps;
  /** 由配置解析的受管 Skill 目录根路径，必须与运行时解析结果一致。 */
  skillsRoot?: string;
  systemSkills?: string[];
  systemWorldError?: string;
  rigNameOverride?: string;
  externalQualifiedIds?: Iterable<string>;
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
  inheritedPermissionPolicy?: PreflightSpecContext["inheritedPermissionPolicy"];
}

/**
 * OPR.0.3.3.24：预检核心除已解析并验证的 spec 外所需的非 YAML 上下文。
 * YAML 只是最前端的输入适配器。
 */
export interface PreflightSpecContext {
  rigRoot: string;
  cwdOverride?: string;
  fsOps: AgentResolverFsOps;
  /** 由配置解析的受管 Skill 目录根路径，必须与运行时解析结果一致。 */
  skillsRoot?: string;
  systemSkills?: string[];
  systemWorldError?: string;
  rigNameOverride?: string;
  /** 结构化扩展所使用的有效持久目标工作组附件。显式 member/fragment 引用仍优先，
   *  此项只是继承的回退值。 */
  inheritedPermissionPolicy?: Pick<
    ResolvedPolicyAttachment,
    "ref" | "origin" | "resolvedTarget" | "declaringDir" | "launchPosture"
  >;
  /** OPR.0.3.4.7 —— 用于异步探测（Codex profile LOAD）的 exec。省略时跳过 Codex
   *  profile 探测，以兼容无法提供 exec 的调用方，例如旧式纯同步测试路径。 */
  exec?: (cmd: string) => Promise<string>;
  /** 受管 Claude 活动 hook 的交付资源路径（relay + 规范 manifest）。默认使用后台服务
   *  随附资源，与 ClaudeCodeAdapter 相同；测试会注入 fixture。通过共享交付检查进行验证，
   *  避免预检与适配器发生偏差。 */
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
}

/**
 * 接缝 C：描述每个席位的有效权限策略附件，不更改就绪性或状态。现有接缝 B 解析器仍是
 * member 优先于工作组的优先级、来源和启动姿态的唯一事实源。
 */
export function permissionPolicyDiscoveryWarnings(
  rigSpec: PodRigSpec,
  preflightCtx: Pick<PreflightSpecContext, "rigRoot" | "fsOps" | "inheritedPermissionPolicy">,
): string[] {
  const warnings: string[] = [];
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      const logicalId = `${pod.id}.${member.id}`;
      const ref = resolvePermissionPolicyRefValue(member.permissionPolicy, rigSpec.permissionPolicy);
      const attachment = ref
        ? resolvePermissionPolicyAttachment(ref, preflightCtx.rigRoot, {
          readFile: (path) => preflightCtx.fsOps.readFile(path),
        })
        : preflightCtx.inheritedPermissionPolicy;
      if (!attachment) {
        warnings.push(`${logicalId}：缺少 permission_policy；launch_posture=floor`);
        continue;
      }
      if (attachment.origin === "deliberate_none") {
        // 已裁定修正（5f37e40f）：展示三种状态的区别。已记录的选择并非缺失；姿态声明
        // 与缺失时的 floor（P2）保持字节一致，只有记录措辞不同。
        warnings.push(`${logicalId}：permission_policy: none（已记录的有意选择）；launch_posture=floor`);
        continue;
      }
      warnings.push(`${logicalId}：permission_policy ref="${attachment.ref}" origin=${attachment.origin} launch_posture=${attachment.launchPosture}`);
    }
  }
  return warnings;
}

/**
 * 重启版工作组预检：验证工作组 spec，解析所有智能体引用与 profile，并检查运行时和 cwd。
 * 这是纯领域逻辑，除读取文件系统外没有副作用。返回现有 PreflightResult 结构
 *（ready + warnings[] + errors[]）。
 * @param input - 工作组 spec YAML、工作组根目录和文件系统操作
 * @returns 预检结果 PreflightResult
 */
export async function rigPreflight(input: RigPreflightInput & { exec?: (cmd: string) => Promise<string> }): Promise<PreflightResult> {
  // 前端（OPR.0.3.3.24）：YAML 只是输入适配器。完成解析、验证和规范化后，把所有实际
  // 检查委托给结构化核心，使持有已解析并验证 spec 的调用方（expand / add_member）无需
  // YAML 往返即可执行预检。此结构与 materialize-core 的拆分方式一致。
  let rigSpec: PodRigSpec;
  try {
    const raw = RigSpecCodec.parse(input.rigSpecYaml);
    const validation = RigSpecSchema.validate(raw, { externalQualifiedIds: input.externalQualifiedIds });
    if (!validation.valid) {
      return { ready: false, errors: validation.errors, warnings: [] };
    }
    rigSpec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  } catch (err) {
    return { ready: false, errors: [`解析错误：${(err as Error).message}`], warnings: [] };
  }

  return preflightValidatedSpec(rigSpec, {
    rigRoot: input.rigRoot,
    cwdOverride: input.cwdOverride,
    fsOps: input.fsOps,
    skillsRoot: input.skillsRoot,
    rigNameOverride: input.rigNameOverride,
    inheritedPermissionPolicy: input.inheritedPermissionPolicy,
    exec: input.exec,
    claudeActivityAssets: input.claudeActivityAssets,
  });
}

/**
 * 预检核心（OPR.0.3.3.24）：每项预检都基于规范化 spec 与非 YAML 上下文，包括会话
 * 名称组件、agent_ref/profile 解析、运行时和 cwd。它从 rigPreflight 中抽取，保持检查、
 * 顺序和错误字符串一致，使 expand/add_member 无需 YAML 往返即可预检结构化 spec；
 * rigPreflight(yaml) 则是其解析与规范化前端。
 */
export async function preflightValidatedSpec(rigSpec: PodRigSpec, preflightCtx: PreflightSpecContext): Promise<PreflightResult> {
  const errors: string[] = [];
  // §6 协调（PM 于 2026-08-05 裁定）：从空数组开始，让 main 已折叠的活动 hook/冲突警告
  //（在下方检查期间加入）排在前面；新加入的权限策略发现警告在返回处追加。理由与语义
  // 边界见返回位置。
  const warnings: string[] = [];

  // 2. 验证所有 pod 成员的会话名称组件。
  const effectiveRigName = preflightCtx.rigNameOverride ?? rigSpec.name;
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      const nameErrors = validateSessionComponents(pod.id, member.id, effectiveRigName);
      for (const err of nameErrors) {
        errors.push(`${pod.id}.${member.id}: ${err}`);
      }
    }
  }

  // 3. 对每个 pod 成员解析 agent_ref 与 profile，并检查运行时和 cwd。
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      // terminal 成员跳过智能体与 profile 解析。
      if (member.agentRef === "builtin:terminal") {
        // terminal 成员只验证运行时和 cwd。
        if (!SUPPORTED_RUNTIMES.has(member.runtime)) {
          errors.push(`${pod.id}.${member.id}：不支持运行时 "${member.runtime}"`);
        }
        if (!member.cwd) {
          errors.push(`${pod.id}.${member.id}：必须提供 cwd`);
        }
        const terminalCwd = resolveLaunchCwd(member.cwd, preflightCtx.rigRoot, preflightCtx.cwdOverride);
        const terminalCwdError = getOpenRigInstallCwdError(terminalCwd, preflightCtx.cwdOverride);
        if (terminalCwdError) {
          errors.push(`${pod.id}.${member.id}: ${terminalCwdError}`);
        }
        continue;
      }

      // 解析 agent_ref。
      const resolveResult = resolveAgentRef(member.agentRef, preflightCtx.rigRoot, preflightCtx.fsOps);
      if (!resolveResult.ok) {
        const msg = resolveResult.code === "validation_failed"
          ? (resolveResult as { errors: string[] }).errors.join("; ")
          : (resolveResult as { error: string }).error;
        errors.push(`${pod.id}.${member.id}：agent_ref 解析失败：${msg}`);
        continue;
      }

      // 将导入冲突作为非致命警告。
      for (const col of resolveResult.collisions) {
        if (col.sources.length >= 2) {
          const hasBase = col.sources.some((s) => s.qualifiedId === col.resourceId);
          if (hasBase) {
            warnings.push(`${pod.id}.${member.id}：${col.category} 中的 "${col.resourceId}" 存在 base/import 冲突`);
          }
          // import/import 冲突会由下方的 profile 解析器捕获。
        }
      }

      // 通过 resolveNodeConfig 解析 profile。
      const ctx: ResolutionContext = {
        baseSpec: resolveResult.resolved,
        importedSpecs: resolveResult.imports,
        collisions: resolveResult.collisions,
        profileName: member.profile,
        specRoot: preflightCtx.rigRoot,
        cwdOverride: preflightCtx.cwdOverride,
        skillsRoot: preflightCtx.skillsRoot,
        systemSkills: preflightCtx.systemSkills,
        systemWorldError: preflightCtx.systemWorldError,
        member,
        pod,
        rig: rigSpec,
      };
      const configResult = resolveNodeConfig(ctx);
      if (!configResult.ok) {
        for (const err of configResult.errors) {
          errors.push(`${pod.id}.${member.id}: ${err}`);
        }
        continue;
      }

      // 受管 Claude 活动 hook 交付预检（非致命）：claude-code 成员选择
      // claude_activity_hooks 资源时，使用适配器共用的验证逻辑确认后台服务确实可以交付
      //（relay 资源存在，且规范 manifest 至少产生一个 relay 事件）。交付缺口只产生警告，
      // 绝不成为门禁；zrig up 会继续，只是不跟踪该席位的活动。
      if (member.runtime === "claude-code") {
        const selectsActivityHooks = configResult.config.selectedResources.runtimeResources.some(
          (qr) => (qr.resource as { type?: string }).type === CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE,
        );
        if (selectsActivityHooks) {
          const relayPath = preflightCtx.claudeActivityAssets?.relayPath ?? DEFAULT_ACTIVITY_RELAY_PATH;
          const manifestPath = preflightCtx.claudeActivityAssets?.manifestPath ?? DEFAULT_CLAUDE_HOOKS_MANIFEST_PATH;
          const delivery = validateClaudeActivityHookDelivery(preflightCtx.fsOps, relayPath, manifestPath);
          if (!delivery.deliverable) {
            const reason = !delivery.relaySourceOk
              ? "缺少 activity-relay 资源"
              : "规范 claude.json hook manifest 缺失、无法读取或没有 relay 事件";
            warnings.push(`${pod.id}.${member.id}：无法交付受管 Claude 活动 hook（${reason}）；zrig up 将继续，但不会跟踪该席位的活动`);
          }
        }
      }

      // 检查运行时。
      if (!SUPPORTED_RUNTIMES.has(member.runtime)) {
        errors.push(`${pod.id}.${member.id}：不支持运行时 "${member.runtime}"`);
      }

      // 检查 cwd；虽然 RigSpec schema 已验证为必填，这里仍再次确认。
      if (!member.cwd) {
        errors.push(`${pod.id}.${member.id}：必须提供 cwd`);
      }
      const cwdError = getOpenRigInstallCwdError(configResult.config.cwd, preflightCtx.cwdOverride);
      if (cwdError) {
        errors.push(`${pod.id}.${member.id}: ${cwdError}`);
      }
    }
  }

  // OPR.0.3.4.7 —— 集成到预检中的 Codex profile LOAD 探测。仅在提供 exec 且同步
  // 检查通过后运行。
  if (errors.length === 0 && preflightCtx.exec) {
    const profileErrors = await verifyCodexProfiles(rigSpec, preflightCtx.exec);
    errors.push(...profileErrors);
    // OPR.0.4.6.PI1 FR-1 —— Pi 二进制探测：spec 包含 pi 成员但二进制缺失时，预检会
    // 给出“问题/原因/修复”错误，而不会把意外推迟到启动时。
    const piErrors = await verifyPiRuntimeAvailable(rigSpec, preflightCtx.exec);
    errors.push(...piErrors);
  }

  // §6 协调——警告发出顺序（PM 于 2026-08-05 裁定）：活动 hook 在前，策略追加在后。
  // 折叠顺序即发出顺序；main 是 restack 的固定基线，已折叠的受管活动 hook 警告作为底层
  //（在上述检查中发出），新 restack 的权限策略发现警告在此之后追加。这符合 rebase 的机械
  // 顺序和门禁优先原则，也让 0.5.0 版本线的既有警告内容在 restack 中保持字节稳定，这才是
  // 真正的稳定性不变量。npm 兼容性不受任一顺序影响：npm 当前发布的是从 0.4.7 切出的
  // POLICY 链，活动 hook 内容则是尚未发布的本地 0.5.0 工作；合并前两种顺序都未曾存在，
  // 此处固定的是合并后的顺序。
  // 语义边界：该顺序只影响展示。任何把首条警告视作更高优先级的消费者都是缺陷，而不是
  // 排序输入；此固定项只冻结展示，不冻结语义。
  warnings.push(...permissionPolicyDiscoveryWarnings(rigSpec, preflightCtx));
  return { ready: errors.length === 0, errors, warnings };
}

/**
 * OPR.0.4.6.PI1 FR-1 —— 异步预检后探测：spec 声明任何 `runtime: "pi"` 成员时，
 * 验证 `pi` 二进制能响应 `pi --version`。失败时返回一条说明问题、原因和修复方式，
 * 并指出安装入口的错误。
 */
export async function verifyPiRuntimeAvailable(
  rigSpec: PodRigSpec,
  exec: ExecFn,
): Promise<string[]> {
  const hasPiMember = (rigSpec.pods ?? []).some((pod: RigSpecPod) =>
    (pod.members ?? []).some((member: RigSpecPodMember) => member.runtime === "pi"),
  );
  if (!hasPiMember) return [];
  try {
    await exec(RUNTIME_COMMANDS["pi"]!);
    return [];
  } catch {
    return [
      `运行时 "pi" 不可用（'pi --version' 执行失败）。spec 声明了 pi 成员，因此启动会失败。修复方法：安装 Pi coding agent（运行 npm install -g @earendil-works/pi-coding-agent，或使用 pi.dev 安装脚本），并确保 PATH 中包含 'pi'。`,
    ];
  }
}

/**
 * OPR.0.3.4.7 —— 异步预检后探测：验证所有 codex_config_profile 非空的 Codex 节点
 * 都能加载 profile-v2。在同步预检通过（已验证 codex --version）后调用。返回要追加到
 * 预检结果的错误；空数组表示所有 profile 都能加载。
 */
export async function verifyCodexProfiles(
  rigSpec: PodRigSpec,
  exec: (cmd: string) => Promise<string>,
): Promise<string[]> {
  const { verifyCodexProfileLoads } = await import("./codex-profile-preflight.js");
  const errors: string[] = [];
  const checkedProfiles = new Set<string>();
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      if (member.runtime !== "codex") continue;
      const profile = member.codexConfigProfile?.trim();
      if (!profile) continue;
      if (checkedProfiles.has(profile)) continue;
      checkedProfiles.add(profile);
      const result = await verifyCodexProfileLoads(profile, exec);
      if (!result.ok) {
        errors.push(`${pod.id}.${member.id}：${result.error}${result.migrationHint ? ` 修复方法：${result.migrationHint}` : ""}`);
      }
    }
  }
  return errors;
}
