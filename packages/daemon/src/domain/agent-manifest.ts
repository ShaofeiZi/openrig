import { parse as parseYaml } from "yaml";
import type {
  AgentSpec, ImportSpec, StartupBlock, StartupFile, StartupAction,
  LifecycleDefaults, AgentResources, ProfileSpec,
  SkillResource, GuidanceResource, SubagentResource, RuntimeResource,
  PluginResource, PluginSource,
  ValidationResult,
} from "./types.js";
import {
  validateStartupBlock as sharedValidateStartupBlock,
  normalizeStartupBlock as sharedNormalizeStartupBlock,
} from "./startup-validation.js";
import { parseSessionName, validateSessionName } from "./session-name.js";

// -- 常量 --
const VALID_EXECUTION_MODES = new Set(["interactive_resident"]);
const VALID_COMPACTION_STRATEGIES = new Set(["default-compaction", "managed-compaction", "handover", "apprentice-handover"]);
/** OPR.0.5.6.20 A1——在弃用窗口内继续接受预留阶段的拼写，并在规范化时明确给出提示，
 * 绝不静默处理。pod_continuity 的处置来自 0.5.2 源映射：handover 实践是
 * pod_continuity 的实现方式，而不是新概念。 */
const DEPRECATED_COMPACTION_ALIASES: Record<string, string> = {
  harness_native: "default-compaction",
  pod_continuity: "handover",
};
/** 压缩策略的规范形式：新值直接通过，弃用别名执行映射，其他值返回 null。这是唯一词汇
 * 定义位置；解析器导入它，而不是重新编码集合，确保只有一条共享解析路径。 */
export function canonicalCompactionStrategy(value: string): string | null {
  if (VALID_COMPACTION_STRATEGIES.has(value)) return value;
  return DEPRECATED_COMPACTION_ALIASES[value] ?? null;
}

/** 连续性 mechanic 地址的唯一接收入口。 */
export function canonicalContinuityMechanic(value: unknown): string | null {
  if (typeof value !== "string" || !validateSessionName(value)) return null;
  return parseSessionName(value).kind === "canonical" ? value : null;
}
const VALID_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const VALID_IMPORT_PREFIXES = ["local:", "path:"];

import { validateSafePath } from "./path-safety.js";

// -- 导入校验 --

function validateImportRef(ref: string, index: number): string | null {
  if (!ref || typeof ref !== "string") return `imports[${index}].ref：必须是非空字符串`;
  const hasValidPrefix = VALID_IMPORT_PREFIXES.some((p) => ref.startsWith(p));
  if (!hasValidPrefix) return `imports[${index}].ref：必须以 "local:" 或 "path:" 开头（收到 "${ref}"）`;
  if (ref.startsWith("local:")) {
    const path = ref.slice("local:".length);
    if (!path) return `imports[${index}].ref：local: 引用必须包含路径`;
    if (path.startsWith("/")) return `imports[${index}].ref：local: 引用必须是相对路径（收到 "${ref}"）`;
  }
  if (ref.startsWith("path:")) {
    const path = ref.slice("path:".length);
    if (!path) return `imports[${index}].ref：path: 引用必须包含路径`;
    if (!path.startsWith("/")) return `imports[${index}].ref：path: 引用必须是绝对路径（收到 "${ref}"）`;
  }
  return null;
}

function validateImportVersion(version: unknown, index: number): string | null {
  if (version === undefined || version === null) return null;
  if (typeof version !== "string") return `imports[${index}].version：必须是字符串`;
  if (/[~^>=<|]/.test(version)) return `imports[${index}].version：不支持版本范围，请使用精确版本（收到 "${version}"）`;
  return null;
}

// 启动校验委托给共享模块。
const validateStartupBlock = sharedValidateStartupBlock;

// -- 生命周期校验 --

function validateLifecycle(raw: unknown, prefix: string): { errors: string[]; advisories: string[] } {
  if (raw === undefined || raw === null) return { errors: [], advisories: [] };
  if (typeof raw !== "object") return { errors: [`${prefix}：必须是对象`], advisories: [] };
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const advisories: string[] = [];
  if (obj["execution_mode"] !== undefined) {
    if (obj["execution_mode"] === "wake_on_demand") {
      errors.push(`${prefix}.execution_mode：v1 不支持 "wake_on_demand"；请使用 "interactive_resident"`);
    } else if (!VALID_EXECUTION_MODES.has(obj["execution_mode"] as string)) {
      errors.push(`${prefix}.execution_mode：必须是 "interactive_resident"（收到 "${obj["execution_mode"]}"）`);
    }
  }
  if (obj["compaction_strategy"] !== undefined) {
    const strategyValue = obj["compaction_strategy"] as string;
    if (strategyValue === "custom_prompt") {
      // OPR.0.5.6.20 A1：此拒绝消息按预留阶段逐字节保留，属于兼容契约。
      errors.push(`${prefix}.compaction_strategy: "custom_prompt" is not supported in v1; use "harness_native" or "pod_continuity"`);
    } else if (DEPRECATED_COMPACTION_ALIASES[strategyValue] !== undefined) {
      advisories.push(`${prefix}.compaction_strategy："${strategyValue}" 已弃用，现在会规范化为 "${DEPRECATED_COMPACTION_ALIASES[strategyValue]}"——请改用当前词汇（${[...VALID_COMPACTION_STRATEGIES].join(", ")}）`);
    } else if (!VALID_COMPACTION_STRATEGIES.has(strategyValue)) {
      errors.push(`${prefix}.compaction_strategy：必须是 ${[...VALID_COMPACTION_STRATEGIES].join(", ")} 之一（收到 "${strategyValue}"）`);
    }
  }
  if (
    obj["mechanic"] !== undefined &&
    canonicalContinuityMechanic(obj["mechanic"]) === null
  ) {
    errors.push(`${prefix}.mechanic：必须是规范 seat@rig 会话地址`);
  }
  if (obj["restore_policy"] !== undefined && !VALID_RESTORE_POLICIES.has(obj["restore_policy"] as string)) {
    errors.push(`${prefix}.restore_policy：必须是 ${[...VALID_RESTORE_POLICIES].join(", ")} 之一（收到 "${obj["restore_policy"]}"）`);
  }
  return { errors, advisories };
}

// -- 资源校验 --

function validateResourcePaths(resources: Array<{ id: string; path: string }>, category: string): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i]!;
    if (!r.id || typeof r.id !== "string") {
      errors.push(`resources.${category}[${i}].id：必须是非空字符串`);
    } else if (ids.has(r.id)) {
      errors.push(`resources.${category}：ID "${r.id}" 重复`);
    } else {
      ids.add(r.id);
    }
    const pathErr = validateSafePath(r.path, `resources.${category}[${i}].path`);
    if (pathErr) errors.push(pathErr);
  }
  return errors;
}

// -- 公共 API --

/**
 * 将原始 YAML 文本解析为无类型对象。
 * @param yamlText agent.yaml 的原始 YAML 内容
 * @returns 解析后的对象
 */
export function parseAgentSpec(yamlText: string): Record<string, unknown> {
  return parseYaml(yamlText) as Record<string, unknown>;
}

/**
 * 校验已解析的 AgentSpec 对象，并收集所有错误。
 * @param raw 已解析的 YAML 对象
 * @returns 包含全部错误的校验结果
 */
export function validateAgentSpec(raw: unknown): ValidationResult {
  const errors: string[] = [];
  // OPR.0.5.6.20——非阻塞弃用提示通过已发布的失败开放通道传递。
  const advisories: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["智能体 spec 必须是对象"] };
  }

  const obj = raw as Record<string, unknown>;
  const hasImports = Array.isArray(obj["imports"]) && obj["imports"].length > 0;

  // 必填字段。
  if (!obj["name"] || typeof obj["name"] !== "string") errors.push("name：必填非空字符串");
  if (!obj["version"] || typeof obj["version"] !== "string") errors.push("version：必填非空字符串");

  // 导入。
  if (obj["imports"] !== undefined) {
    if (!Array.isArray(obj["imports"])) {
      errors.push("imports：必须是数组");
    } else {
      for (let i = 0; i < (obj["imports"] as unknown[]).length; i++) {
        const imp = (obj["imports"] as Record<string, unknown>[])[i]!;
        const refErr = validateImportRef(imp["ref"] as string, i);
        if (refErr) errors.push(refErr);
        const verErr = validateImportVersion(imp["version"], i);
        if (verErr) errors.push(verErr);
      }
    }
  }

  // 默认生命周期。
  if (obj["defaults"] && typeof obj["defaults"] === "object") {
    const defaults = obj["defaults"] as Record<string, unknown>;
    if (defaults["lifecycle"]) {
      {
        const lifecycleResult = validateLifecycle(defaults["lifecycle"], "defaults.lifecycle");
        errors.push(...lifecycleResult.errors);
        advisories.push(...lifecycleResult.advisories);
      }
    }
  }

  // 启动配置。
  errors.push(...validateStartupBlock(obj["startup"], "startup"));

  // profile 结构校验。
  if (obj["profiles"] !== undefined && (typeof obj["profiles"] !== "object" || Array.isArray(obj["profiles"]) || obj["profiles"] === null)) {
    errors.push("profiles：必须是 map（对象），不能是数组或标量");
  }

  // profile 启动配置和生命周期。
  if (obj["profiles"] && typeof obj["profiles"] === "object" && !Array.isArray(obj["profiles"])) {
    for (const [profileName, profileRaw] of Object.entries(obj["profiles"] as Record<string, unknown>)) {
      if (profileRaw && typeof profileRaw === "object") {
        const p = profileRaw as Record<string, unknown>;
        errors.push(...validateStartupBlock(p["startup"], `profiles.${profileName}.startup`));
        if (p["lifecycle"]) {
          {
            const lifecycleResult = validateLifecycle(p["lifecycle"], `profiles.${profileName}.lifecycle`);
            errors.push(...lifecycleResult.errors);
            advisories.push(...lifecycleResult.advisories);
          }
        }
      }
    }
  }

  // 资源。
  // 下方 profile.uses 校验也会使用 allLocalIds；无论 resources 块是否存在都构造它
  //（缺失时各 map 为空），这样没有 resources 块的 spec 仍可校验 profiles。
  const allLocalIds: Record<string, Set<string>> = {
    skills: new Set(),
    guidance: new Set(),
    subagents: new Set(),
    plugins: new Set(),
    runtime_resources: new Set(),
  };

  if (obj["resources"] && typeof obj["resources"] === "object") {
    const res = obj["resources"] as Record<string, unknown>;

    // 以明确迁移错误拒绝旧版 resources.hooks 字段。根据 redo-guard-2
    // BLOCKING-CONCERN 2026-05-10，normalize 时静默丢弃不足以提供向后兼容；
    // 必须向操作者明确指出迁移目标，促使其更新 spec。
    if (res["hooks"] !== undefined) {
      errors.push(`resources.hooks：已在 plugin-primitive（阶段 3a）中移除。Hooks 现在随 plugins 发布；请改在 resources.plugins[] 下声明 plugin。参见 plugin-primitive DESIGN.md §3。`);
    }

    for (const category of ["skills", "guidance", "subagents", "plugins", "runtime_resources"]) {
      const items = res[category];
      if (items !== undefined) {
        if (!Array.isArray(items)) {
          errors.push(`resources.${category}：必须是数组`);
        } else {
          const entries = items as Array<Record<string, unknown>>;

          if (category === "plugins") {
            // Plugin 条目结构不同（id + source 对象），在此内联校验。
            errors.push(...validatePluginResources(entries));
            allLocalIds[category] = new Set(entries.map((e) => e["id"] as string).filter(Boolean));
          } else {
            errors.push(...validateResourcePaths(entries as Array<{ id: string; path: string }>, category));
            allLocalIds[category] = new Set(entries.map((e) => e["id"] as string).filter(Boolean));
          }

          // runtime_resources 必须包含 runtime 字段。
          if (category === "runtime_resources") {
            for (let i = 0; i < entries.length; i++) {
              if (!entries[i]!["runtime"] || typeof entries[i]!["runtime"] !== "string") {
                errors.push(`resources.runtime_resources[${i}].runtime：必填非空字符串`);
              }
              if (!entries[i]!["type"] || typeof entries[i]!["type"] !== "string") {
                errors.push(`resources.runtime_resources[${i}].type：必填非空字符串`);
              }
            }
          }
        }
      }
    }
  }

  // Profile uses 校验——即使未声明 resources 块也会运行，使旧版 profile.uses.hooks 拒绝
  // 和缺失引用检测覆盖所有 spec 形态。
  if (obj["profiles"] && typeof obj["profiles"] === "object" && !Array.isArray(obj["profiles"])) {
    for (const [profileName, profileRaw] of Object.entries(obj["profiles"] as Record<string, unknown>)) {
      if (profileRaw && typeof profileRaw === "object") {
        const p = profileRaw as Record<string, unknown>;
        if (p["uses"] && typeof p["uses"] === "object") {
          const uses = p["uses"] as Record<string, unknown>;

          // 以明确迁移错误拒绝旧版 profile.uses.hooks 字段。
          // 依据 redo-guard-2 BLOCKING-CONCERN 2026-05-10。
          if (uses["hooks"] !== undefined) {
            errors.push(`profiles.${profileName}.uses.hooks：已在 plugin-primitive（阶段 3a）中移除。请改为通过 profiles.${profileName}.uses.plugins[] 引用 plugins。`);
          }

          for (const category of ["skills", "guidance", "subagents", "plugins", "runtime_resources"]) {
            const refs = uses[category];
            if (Array.isArray(refs)) {
              for (const ref of refs as string[]) {
                // 接受限定引用（namespace:id），供后续解析。
                if (typeof ref === "string" && ref.includes(":")) {
                  const parts = ref.split(":");
                  if (parts.length < 2 || !parts[0] || !parts[1]) {
                    errors.push(`profiles.${profileName}.uses.${category}：限定引用 "${ref}" 无效（必须为 namespace:id）`);
                  }
                  // 其他限定引用暂时接受——导入解析在 AS-T03 完成。
                } else if (typeof ref === "string") {
                  // 非限定引用必须存在于本地声明中。
                  if (!allLocalIds[category]?.has(ref) && !hasImports) {
                    errors.push(`profiles.${profileName}.uses.${category}：在已声明资源中找不到资源 "${ref}"`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, ...(advisories.length > 0 ? { advisories } : {}) };
}

/**
 * 将已验证的 AgentSpec 规范化为标准类型结构，并为可选字段应用默认值。
 * @param raw 已解析的 YAML 对象（必须先通过校验）
 * @returns 规范化后的 AgentSpec
 */
export function normalizeAgentSpec(raw: Record<string, unknown>): AgentSpec {
  const imports: ImportSpec[] = Array.isArray(raw["imports"])
    ? (raw["imports"] as Record<string, unknown>[]).map((imp) => ({
        ref: imp["ref"] as string,
        version: imp["version"] as string | undefined,
      }))
    : [];

  const startup = normalizeStartupBlock(raw["startup"]);

  const resources = normalizeResources(raw["resources"]);

  const profiles: Record<string, ProfileSpec> = {};
  if (raw["profiles"] && typeof raw["profiles"] === "object" && !Array.isArray(raw["profiles"])) {
    for (const [name, profileRaw] of Object.entries(raw["profiles"] as Record<string, unknown>)) {
      profiles[name] = normalizeProfile(profileRaw as Record<string, unknown>);
    }
  }

  const defaults = raw["defaults"] as Record<string, unknown> | undefined;

  const result: AgentSpec = {
    version: raw["version"] as string,
    name: raw["name"] as string,
    summary: raw["summary"] as string | undefined,
    imports,
    startup,
    resources,
    profiles,
  };

  if (defaults) {
    // OPR.0.5.6.20：lifecycle 始终在 DEFAULTS 层物化，使默认值（F-6 定义的
    // default-compaction，以及恢复策略 resume_if_possible）显式可见，而不是靠字段缺失暗示。
    // B-3/B-4：只有此层执行物化；profile 块保留缺失状态，使未声明字段的层级不参与优先级。
    const lifecycle = normalizeLifecycle((defaults["lifecycle"] as Record<string, unknown>) ?? {});
    result.defaults = {
      runtime: defaults["runtime"] as string | undefined,
      model: defaults["model"] as string | undefined,
      lifecycle: {
        ...lifecycle,
        compactionStrategy: lifecycle.compactionStrategy ?? "default-compaction",
        restorePolicy: lifecycle.restorePolicy ?? "resume_if_possible",
      },
    };
  }

  return result;
}

// -- 规范化辅助函数 --

const normalizeStartupBlock = sharedNormalizeStartupBlock;

function normalizeLifecycle(raw: Record<string, unknown>): LifecycleDefaults {
  // OPR.0.5.6.20 B-3/B-4：保留字段缺失，绝不在此物化。省略字段的 lifecycle 块不能
  // 获得一个随后参与优先级计算的值；默认值只由 defaults 层调用点负责物化。
  const rawStrategy = raw["compaction_strategy"] as string | undefined;
  return {
    executionMode: (raw["execution_mode"] as LifecycleDefaults["executionMode"]) ?? "interactive_resident",
    compactionStrategy: rawStrategy !== undefined
      ? ((canonicalCompactionStrategy(rawStrategy) ?? "default-compaction") as LifecycleDefaults["compactionStrategy"])
      : undefined,
    mechanic: raw["mechanic"] !== undefined
      ? (canonicalContinuityMechanic(raw["mechanic"]) ?? undefined)
      : undefined,
    restorePolicy: raw["restore_policy"] !== undefined
      ? (raw["restore_policy"] as LifecycleDefaults["restorePolicy"])
      : undefined,
  };
}

function normalizeResources(raw: unknown): AgentResources {
  if (!raw || typeof raw !== "object") {
    return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
  }
  const obj = raw as Record<string, unknown>;

  return {
    skills: Array.isArray(obj["skills"])
      ? (obj["skills"] as Record<string, unknown>[]).map((s) => ({ id: s["id"] as string, path: s["path"] as string }))
      : [],
    guidance: Array.isArray(obj["guidance"])
      ? (obj["guidance"] as Record<string, unknown>[]).map((g) => ({
          id: g["id"] as string, path: g["path"] as string,
          target: g["target"] as string, merge: (g["merge"] as GuidanceResource["merge"]) ?? "managed_block",
        }))
      : [],
    subagents: Array.isArray(obj["subagents"])
      ? (obj["subagents"] as Record<string, unknown>[]).map((s) => ({ id: s["id"] as string, path: s["path"] as string }))
      : [],
    plugins: Array.isArray(obj["plugins"])
      ? (obj["plugins"] as Record<string, unknown>[]).map(normalizePluginResource)
      : [],
    runtimeResources: Array.isArray(obj["runtime_resources"])
      ? (obj["runtime_resources"] as Record<string, unknown>[]).map((r) => ({
          id: r["id"] as string, path: r["path"] as string,
          runtime: r["runtime"] as string, type: r["type"] as string,
        }))
      : [],
  };
}

function normalizePluginResource(raw: Record<string, unknown>): PluginResource {
  const sourceRaw = (raw["source"] ?? {}) as Record<string, unknown>;
  const source: PluginSource = {
    kind: "local",
    path: sourceRaw["path"] as string,
  };
  const result: PluginResource = {
    id: raw["id"] as string,
    source,
  };
  const pluginType = raw["plugin_type"] ?? raw["pluginType"];
  if (pluginType === "claude" || pluginType === "codex" || pluginType === "auto") {
    result.pluginType = pluginType;
  }
  return result;
}

function validatePluginResources(entries: Array<Record<string, unknown>>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry["id"] || typeof entry["id"] !== "string") {
      errors.push(`resources.plugins[${i}].id：必须是非空字符串`);
    } else if (ids.has(entry["id"] as string)) {
      errors.push(`resources.plugins：ID "${entry["id"]}" 重复`);
    } else {
      ids.add(entry["id"] as string);
    }

    const source = entry["source"];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      errors.push(`resources.plugins[${i}].source：必须是包含 kind 和来源专属字段的对象`);
      continue;
    }
    const sourceObj = source as Record<string, unknown>;
    const kind = sourceObj["kind"];
    if (kind !== "local") {
      errors.push(`resources.plugins[${i}].source.kind：v0 仅支持 "local"（收到 "${String(kind)}"）`);
      continue;
    }
    // Plugin 路径可以是绝对路径，例如 vendored plugin 的 ~/.openrig/plugins/<id> 或项目
    // 绝对路径。跳过 spec 内资源所用的安全路径检查；plugin 源是操作者显式管理的路径。
    const pluginPath = sourceObj["path"];
    if (!pluginPath || typeof pluginPath !== "string") {
      errors.push(`resources.plugins[${i}].source.path：必须是非空字符串`);
    }

    const pluginType = entry["plugin_type"] ?? entry["pluginType"];
    if (pluginType !== undefined && pluginType !== "claude" && pluginType !== "codex" && pluginType !== "auto") {
      errors.push(`resources.plugins[${i}].plugin_type：必须是 "claude" | "codex" | "auto"（收到 "${String(pluginType)}"）`);
    }
  }
  return errors;
}

function normalizeProfile(raw: Record<string, unknown>): ProfileSpec {
  const uses = raw["uses"] as Record<string, unknown> | undefined;
  return {
    summary: raw["summary"] as string | undefined,
    preferences: raw["preferences"] as { runtime?: string; model?: string } | undefined,
    startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
    lifecycle: raw["lifecycle"] ? normalizeLifecycle(raw["lifecycle"] as Record<string, unknown>) : undefined,
    uses: {
      skills: Array.isArray(uses?.["skills"]) ? uses["skills"] as string[] : [],
      guidance: Array.isArray(uses?.["guidance"]) ? uses["guidance"] as string[] : [],
      subagents: Array.isArray(uses?.["subagents"]) ? uses["subagents"] as string[] : [],
      plugins: Array.isArray(uses?.["plugins"]) ? uses["plugins"] as string[] : [],
      runtimeResources: Array.isArray(uses?.["runtime_resources"]) ? uses["runtime_resources"] as string[] : [],
    },
    activity: normalizeActivityBlock(raw["activity"]),
  };
}

/**
 * Slice 15——解析 `profile.activity` 块。该块缺失或其中的 `silence_window_seconds` 无效
 *（非整数或超出 [1, 3600]）时返回 undefined，随后后台服务使用默认值 3 秒。此处会静默
 * 丢弃无效值；若操作者反馈这种行为难以理解，可再给 validateAgentSpec 添加显式错误路径；
 * 对 v0 而言，丢弃是更安全、更简单的选择。
 *
 * 同时接受 YAML snake_case（`silence_window_seconds`）和类型接口使用的 camelCase
 *（`silenceWindowSeconds`）形式。
 */
function normalizeActivityBlock(raw: unknown): { silenceWindowSeconds?: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const candidate = obj["silence_window_seconds"] ?? obj["silenceWindowSeconds"];
  if (typeof candidate !== "number") return undefined;
  if (!Number.isFinite(candidate)) return undefined;
  if (!Number.isInteger(candidate)) return undefined;
  if (candidate < 1 || candidate > 3600) return undefined;
  return { silenceWindowSeconds: candidate };
}
