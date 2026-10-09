import nodePath from "node:path";
import { canonicalCompactionStrategy, canonicalContinuityMechanic } from "./agent-manifest.js";
import { homedir as osHomedir } from "node:os";
import type {
  AgentSpec, AgentResources, ProfileSpec, LifecycleDefaults,
  RigSpec, RigSpecPod, RigSpecPodMember, StartupBlock,
  SkillResource, GuidanceResource, SubagentResource, RuntimeResource, PluginResource,
} from "./types.js";
import type { ResolvedAgentSpec, ResourceCollision } from "./agent-resolver.js";
import { resolveStartup } from "./startup-resolver.js";
import { discoverSkillsForRuntime, type SkillRuntime } from "./skill-discovery.js";
import { inspectSkillDirectory, resolveSkillLoadout, type SkillLoadout } from "./skill-catalog.js";

// -- 类型 --

export interface QualifiedResource {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | RuntimeResource | PluginResource;
}

export interface ResolvedResources {
  skills: QualifiedResource[];
  guidance: QualifiedResource[];
  subagents: QualifiedResource[];
  plugins: QualifiedResource[];
  runtimeResources: QualifiedResource[];
}

export interface ResolvedNodeConfig {
  runtime: string;
  model: string | undefined;
  cwd: string;
  restorePolicy: string;
  /** OPR.0.5.6.20——已解析的连续性模式（规范词汇，最具体者优先）。 */
  compactionStrategy: string;
  /** 已解析的连续性机制；仅显式声明时存在。 */
  mechanic: string | undefined;
  lifecycle: LifecycleDefaults | undefined;
  selectedResources: ResolvedResources;
  startup: StartupBlock;
  resolvedSpecName: string;
  resolvedSpecVersion: string;
  resolvedSpecHash: string;
  /**
   * 逐席位的活动检测调优。agent manifest 归一化后，从 `profile.activity` 原样转发。
   * 当前尚未生效：实时轮询器使用全局 3 秒默认值，不读取逐席位窗口。保留供未来逐席位决策使用。
   */
  activity?: { silenceWindowSeconds?: number };
  /** 有效技能选择中归 catalog 所有的部分。运行时投影用它做精确字节的所有权协调。 */
  skillLoadout?: SkillLoadout;
}

export interface ResolutionContext {
  baseSpec: ResolvedAgentSpec;
  importedSpecs: ResolvedAgentSpec[];
  collisions: ResourceCollision[];
  profileName: string;
  specRoot?: string;
  cwdOverride?: string;
  member: RigSpecPodMember;
  pod: RigSpecPod;
  rig: RigSpec;
  operatorStartup?: StartupBlock;
  /** V0.3.0 daemon-skill-discovery（SC-29 #7）：操作者主目录，用于扫描文件系统中发现的技能
   *（~/.openrig/skills/、~/.claude/skills/、~/.agents/skills/）。生产环境默认使用
   * os.homedir()；测试注入 fixture 根目录。 */
  homedir?: string;
  /** 由配置解析出的受管技能 catalog 根目录。 */
  skillsRoot?: string;
  /** 归 System World 所有的受管技能身份。缺失时，旧版 catalog.yaml selector 仍作为兼容回退。 */
  systemSkills?: string[];
  /** 已选择但无法解析的 System World。这会拒绝启动，绝不静默回退到旧版 catalog selector。 */
  systemWorldError?: string;
}

export type ResolutionResult =
  | { ok: true; config: ResolvedNodeConfig }
  | { ok: false; errors: string[] };

// -- 常量 --

const RESOURCE_CATEGORIES = ["skills", "guidance", "subagents", "plugins", "runtimeResources"] as const;
type ResourceCategory = typeof RESOURCE_CATEGORIES[number];

const YAML_CATEGORY_MAP: Record<string, ResourceCategory> = {
  skills: "skills",
  guidance: "guidance",
  subagents: "subagents",
  plugins: "plugins",
  runtime_resources: "runtimeResources",
  runtimeResources: "runtimeResources",
};

const RESTORE_POLICY_LEVEL: Record<string, number> = {
  resume_if_possible: 0,
  relaunch_fresh: 1,
  checkpoint_only: 2,
};

// -- 公共 API --

/**
 * 从 agent spec、profile 与工作组上下文解析有效节点配置。
 * @param ctx - 包含全部输入的解析上下文
 * @returns 已解析配置或错误
 */
export function resolveNodeConfig(ctx: ResolutionContext): ResolutionResult {
  const errors: string[] = [];
  if (ctx.systemWorldError) return { ok: false, errors: [`system_world_invalid: ${ctx.systemWorldError}`] };
  const { baseSpec, importedSpecs, profileName, member, pod, rig } = ctx;
  const spec = baseSpec.spec;

  // 1. 校验 profile 存在。
  const profile = spec.profiles[profileName];
  if (!profile) {
    return { ok: false, errors: [`在 spec "${spec.name}" 中未找到 Profile "${profileName}"。可用：${Object.keys(spec.profiles).join(", ") || "（无）"}` ] };
  }

  // 2. 构建合并后的资源池。
  const pool = buildResourcePool(baseSpec, importedSpecs);

  // V0.3.0 daemon-skill-discovery（SC-29 #7）：查询资源池前必须先解析 runtime + cwd，
  // 这样文件系统技能扫描才会在正确 cwd 下命中对应运行时的路径布局
  //（claude-code → .claude/；codex → .agents/）。旧版本在资源池之后计算 runtime/cwd，
  // 此处已调整顺序。
  const runtime = member.runtime
    ?? profile.preferences?.runtime
    ?? spec.defaults?.runtime
    ?? "claude-code";

  const model = member.model
    ?? profile.preferences?.model
    ?? spec.defaults?.model;

  const cwd = ctx.cwdOverride
    ? nodePath.resolve(ctx.cwdOverride)
    : ctx.specRoot
      ? (nodePath.isAbsolute(member.cwd) ? member.cwd : nodePath.resolve(ctx.specRoot, member.cwd))
      : member.cwd;

  // 2b. 用文件系统发现的技能扩充资源池。工作组本地 resources.skills（已由 buildResourcePool
  // 放入池中）优先于同 id 的发现项。最具体者优先顺序为：工作组本地 agent.yaml >
  // 工作组随附 cwd > spec-install-dir > 运行时专属用户库 > 共享 ~/.openrig/skills/。
  // 发现根的内部顺序定义在 skill-discovery.listScanRoots；此处只保证发现结果不会覆盖
  // 工作组本地声明。
  let rejectedSkillsByBasename: Map<string, { path: string; reason: string }> = new Map();
  if (runtime === "claude-code" || runtime === "codex") {
    const discovery = discoverSkillsForRuntime({
      runtime: runtime as SkillRuntime,
      homedir: ctx.homedir ?? osHomedir(),
      cwd,
      specInstallDir: ctx.specRoot,
      ...(ctx.skillsRoot ? { skillsRoot: ctx.skillsRoot } : {}),
    });
    for (const discovered of discovery.skills) {
      if (pool.skills.has(discovered.id)) continue; // rig-local-wins
      pool.skills.set(discovered.id, [{
        effectiveId: discovered.id,
        sourceSpec: "discovered",
        sourcePath: discovered.path,
        resource: discovered,
      }]);
    }
    // 按目录 basename 索引被拒绝技能，使 profile 引用与结构损坏 SKILL.md 同名的技能时，
    // 能得到精确拒绝原因，而不是笼统的“资源池中未找到”错误。
    for (const r of discovery.rejected) {
      const base = nodePath.basename(r.path);
      if (!rejectedSkillsByBasename.has(base)) rejectedSkillsByBasename.set(base, r);
    }
  }

  // 3. 在扩充后的资源池中解析 profile uses。
  const selectedResult = resolveProfileUses(profile, pool, spec.name, errors);
  if (errors.length > 0) {
    // 若 basename 命中“已发现但被拒绝”的 SKILL.md 目录，则为“skills: \"<id>\" 在资源池中
    // 未找到”补充结构性拒绝原因，使操作者准确知道应修复什么，而不是只看到模糊的池缺失。
    const enhanced = errors.map((err) => {
      const m = err.match(/^Profile 使用的 skills："([^"]+)" 未在资源池中找到$/);
      if (!m) return err;
      const ref = m[1]!;
      const rejection = rejectedSkillsByBasename.get(ref);
      if (!rejection) return err;
      return `Profile 使用技能 "${ref}" 被拒绝——${rejection.reason}（位于 ${rejection.path}）`;
    });
    return { ok: false, errors: enhanced };
  }

  // S04——围绕既有拓扑 selector（profile.uses.skills）组合独立选择的受管技能。System 来源为
  // catalog.yaml，project 来源为 project.yaml install.skills；不受 catalog 管理的拓扑资源
  // 保留既有 AgentSpec/本地行为。
  const catalogRoot = ctx.skillsRoot ?? nodePath.join(ctx.homedir ?? osHomedir(), ".openrig", "skills");
  const catalogResult = resolveSkillLoadout({
    catalogRoot,
    ...(ctx.systemSkills !== undefined ? { systemSkills: ctx.systemSkills } : {}),
    topologySkills: profile.uses.skills,
    projectRoot: cwd,
    allowMissingTopology: true,
  });
  if (!catalogResult.ok) {
    return { ok: false, errors: catalogResult.errors.map((error) => `${error.code}: ${error.message}`) };
  }
  for (const managed of catalogResult.loadout.entries) {
    const qualified: QualifiedResource = {
      effectiveId: managed.id,
      sourceSpec: `skill-catalog@${managed.revision}`,
      sourcePath: managed.sourceRoot,
      resource: { id: managed.id, path: nodePath.relative(managed.sourceRoot, managed.sourceDir) },
    };
    const index = selectedResult!.skills.findIndex((entry) => {
      const resource = entry.resource as SkillResource;
      return entry.effectiveId === managed.id || resource.id === managed.id;
    });
    if (index >= 0) {
      const existing = selectedResult!.skills[index]!;
      const resource = existing.resource as SkillResource;
      const existingPath = nodePath.isAbsolute(resource.path)
        ? resource.path
        : nodePath.resolve(existing.sourcePath, resource.path);
      try {
        const existingDigest = inspectSkillDirectory(existingPath).digest;
        if (existingDigest !== managed.digest) {
          return {
            ok: false,
            errors: [
              `skill_identity_conflict: 拓扑选择 '${managed.id}' 在 ${existingPath} 解析到与受管目录 ${managed.sourceDir} 不同的内容；请移除重复来源，或使字节完全一致`,
            ],
          };
        }
      } catch (err) {
        return {
          ok: false,
          errors: [`skill_identity_conflict: 无法在 ${existingPath} 比较拓扑选择 '${managed.id}'：${(err as Error).message}`],
        };
      }
      selectedResult!.skills[index] = qualified;
    }
    else selectedResult!.skills.push(qualified);
  }
  selectedResult!.skills.sort((a, b) => a.effectiveId < b.effectiveId ? -1 : a.effectiveId > b.effectiveId ? 1 : 0);

  // 7. 按收窄规则解析 restorePolicy。
  const restorePolicyResult = resolveRestorePolicy(spec, profile, member);
  if (!restorePolicyResult.ok) {
    return { ok: false, errors: [restorePolicyResult.error] };
  }

  // 7b. 解析 compactionStrategy（OPR.0.5.6.20——覆盖优先，别名归一化）。
  const compactionResult = resolveCompactionStrategy(spec, profile, member);
  if (!compactionResult.ok) {
    return { ok: false, errors: [compactionResult.error] };
  }
  const mechanicResult = resolveContinuityMechanic(spec, profile, member);
  if (!mechanicResult.ok) {
    return { ok: false, errors: [mechanicResult.error] };
  }

  // 8. 解析 lifecycle。
  const lifecycle = profile.lifecycle ?? spec.defaults?.lifecycle;

  // 9. 解析启动分层。
  const startup = resolveStartup({
    specStartup: spec.startup,
    profileStartup: profile.startup,
    rigCultureFile: rig.cultureFile,
    rigStartup: rig.startup,
    podStartup: pod.startup,
    memberStartup: member.startup,
    operatorStartup: ctx.operatorStartup,
  });

  return {
    ok: true,
    config: {
      runtime,
      model,
      cwd,
      restorePolicy: restorePolicyResult.policy,
      compactionStrategy: compactionResult.strategy,
      mechanic: mechanicResult.mechanic,
      lifecycle,
      selectedResources: selectedResult!,
      startup,
      resolvedSpecName: spec.name,
      resolvedSpecVersion: spec.version,
      resolvedSpecHash: baseSpec.hash,
      // Slice 15——透传已解析 activity block；profile 未声明时为 undefined。
      // 缺失时由 NodeLauncher 应用默认 3 秒值。
      activity: profile.activity,
      skillLoadout: catalogResult.loadout,
    },
  };
}

// -- 资源池 --

interface PoolEntry {
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resource: SkillResource | GuidanceResource | SubagentResource | RuntimeResource | PluginResource;
}

type ResourcePool = Record<ResourceCategory, Map<string, PoolEntry[]>>;

function buildResourcePool(base: ResolvedAgentSpec, imports: ResolvedAgentSpec[]): ResourcePool {
  const pool: ResourcePool = {
    skills: new Map(),
    guidance: new Map(),
    subagents: new Map(),
    plugins: new Map(),
    runtimeResources: new Map(),
  };

  // 基础 spec 资源（非限定 id）。
  for (const cat of RESOURCE_CATEGORIES) {
    const resources = (base.spec.resources[cat] as Array<{ id: string }> | undefined) ?? [];
    for (const r of resources) {
      const entries = pool[cat].get(r.id) ?? [];
      entries.push({ effectiveId: r.id, sourceSpec: base.spec.name, sourcePath: base.sourcePath, resource: r as PoolEntry["resource"] });
      pool[cat].set(r.id, entries);
    }
  }

  // 导入 spec 资源（仅限定 id）。按提案：基础资源保留非限定本地 id；
  // 冲突的导入资源只能通过限定 id 寻址。
  for (const imp of imports) {
    for (const cat of RESOURCE_CATEGORIES) {
      const resources = (imp.spec.resources[cat] as Array<{ id: string }> | undefined) ?? [];
      for (const r of resources) {
        const qualifiedId = `${imp.spec.name}:${r.id}`;
        // 只按限定 id 建索引。
        const qualEntries = pool[cat].get(qualifiedId) ?? [];
        qualEntries.push({ effectiveId: qualifiedId, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] });
        pool[cat].set(qualifiedId, qualEntries);

        // 若不存在同 id 的基础资源，也按非限定 id 建索引，使单个导入资源可不加限定符引用。
        // 若基础资源存在，则非限定 id 归基础资源所有，不产生冲突；若多个导入共享同一非限定 id
        // 且没有基础资源，则该引用有歧义。
        if (!pool[cat].has(r.id)) {
          pool[cat].set(r.id, [{ effectiveId: r.id, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] }]);
        } else {
          const existing = pool[cat].get(r.id)!;
          // 仅当现有条目不来自基础 spec 时，才把它加入歧义集合。
          const hasBase = existing.some((e) => e.sourceSpec === base.spec.name);
          if (!hasBase) {
            existing.push({ effectiveId: qualifiedId, sourceSpec: imp.spec.name, sourcePath: imp.sourcePath, resource: r as PoolEntry["resource"] });
          }
          // 若基础资源拥有该 id，导入版本只能通过限定 id 访问，不建立非限定索引。
        }
      }
    }
  }

  return pool;
}

function resolveProfileUses(
  profile: ProfileSpec,
  pool: ResourcePool,
  baseSpecName: string,
  errors: string[],
): ResolvedResources | null {
  const result: ResolvedResources = {
    skills: [],
    guidance: [],
    subagents: [],
    plugins: [],
    runtimeResources: [],
  };

  const usesMap: Record<string, string[]> = {
    skills: profile.uses.skills,
    guidance: profile.uses.guidance,
    subagents: profile.uses.subagents,
    plugins: profile.uses.plugins,
    runtimeResources: profile.uses.runtimeResources,
  };

  for (const cat of RESOURCE_CATEGORIES) {
    const refs = usesMap[cat] ?? [];
    for (const ref of refs) {
      const entries = pool[cat].get(ref);
      if (!entries || entries.length === 0) {
        errors.push(`Profile 使用的 ${cat}："${ref}" 未在资源池中找到`);
        continue;
      }
      if (entries.length > 1) {
        // 非限定引用有歧义。
        const sources = entries.map((e) => e.sourceSpec).join(", ");
        errors.push(`Profile 使用的 ${cat}："${ref}" 存在歧义（声明于：${sources}）。请使用类似 "specname:${ref}" 的限定 ID`);
        continue;
      }
      result[cat].push({
        effectiveId: entries[0]!.effectiveId,
        sourceSpec: entries[0]!.sourceSpec,
        sourcePath: entries[0]!.sourcePath,
        resource: entries[0]!.resource,
      });
    }
  }

  return errors.length > 0 ? null : result;
}

// -- 恢复策略收窄 --

/** OPR.0.5.6.20——最具体者优先（spec default < profile < member）。这里沿用 restore-policy
 * 模式但不采用其收窄格：四种 continuity mode 无序，因此更具体层级直接覆盖。别名通过 manifest
 * 的唯一词汇点归一化；任一层级出现无效值时，错误会点名该值。 */
function resolveCompactionStrategy(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; strategy: string } | { ok: false; error: string } {
  let current = "default-compaction";
  const specValue = spec.defaults?.lifecycle?.compactionStrategy;
  if (specValue) {
    const canonical = canonicalCompactionStrategy(specValue);
    if (canonical === null) return { ok: false, error: `spec defaults 中的 compactionStrategy 无效："${specValue}"` };
    current = canonical;
  }
  const profileValue = (profile.lifecycle as { compactionStrategy?: string } | undefined)?.compactionStrategy;
  if (profileValue) {
    const canonical = canonicalCompactionStrategy(profileValue);
    if (canonical === null) return { ok: false, error: `profile 中的 compactionStrategy 无效："${profileValue}"` };
    current = canonical;
  }
  if (member.compactionStrategy) {
    const canonical = canonicalCompactionStrategy(member.compactionStrategy);
    if (canonical === null) return { ok: false, error: `member 中的 compactionStrategy 无效："${member.compactionStrategy}"` };
    current = canonical;
  }
  return { ok: true, strategy: current };
}

/** S20 A8：mechanic 严格遵循已交付的策略路径：spec default < profile < member。 */
function resolveContinuityMechanic(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; mechanic: string | undefined } | { ok: false; error: string } {
  let current: string | undefined;
  for (const [level, value] of [
    ["spec 默认值", spec.defaults?.lifecycle?.mechanic],
    ["profile", profile.lifecycle?.mechanic],
    ["member", member.mechanic],
  ] as const) {
    if (value === undefined) continue;
    const canonical = canonicalContinuityMechanic(value);
    if (canonical === null) {
      return { ok: false, error: `${level} 中的 mechanic 无效："${String(value)}"` };
    }
    current = canonical;
  }
  return { ok: true, mechanic: current };
}

function resolveRestorePolicy(
  spec: AgentSpec,
  profile: ProfileSpec,
  member: RigSpecPodMember,
): { ok: true; policy: string } | { ok: false; error: string } {
  let current: string = spec.defaults?.lifecycle?.restorePolicy ?? "resume_if_possible";
  let currentLevel = RESTORE_POLICY_LEVEL[current] ?? 0;

  // Profile 收窄。
  if (profile.lifecycle?.restorePolicy) {
    const profileLevel = RESTORE_POLICY_LEVEL[profile.lifecycle.restorePolicy];
    if (profileLevel === undefined) {
      return { ok: false, error: `profile 中的 restorePolicy 无效："${profile.lifecycle.restorePolicy}"` };
    }
    if (profileLevel < currentLevel) {
      return { ok: false, error: `Profile restorePolicy "${profile.lifecycle.restorePolicy}" 扩宽了 "${current}"——只允许收窄` };
    }
    current = profile.lifecycle.restorePolicy;
    currentLevel = profileLevel;
  }

  // Member 收窄。
  if (member.restorePolicy) {
    const memberLevel = RESTORE_POLICY_LEVEL[member.restorePolicy];
    if (memberLevel === undefined) {
      return { ok: false, error: `member 上的 restorePolicy 无效："${member.restorePolicy}"` };
    }
    if (memberLevel < currentLevel) {
      return { ok: false, error: `Member restorePolicy "${member.restorePolicy}" 扩宽了 "${current}"——只允许收窄` };
    }
    current = member.restorePolicy;
  }

  return { ok: true, policy: current };
}
