// Slice-03（OPR.0.4.8.3）接缝 B——permission_policy REF 解析、优先级与 launch-posture。
// 附加到 rig 或 seat 的 `permission_policy` 值是 REF，而非 policy body。语义以 Slice03 README v4
//（sha256-8 d65afe67）、裁定 A1/A2/A3 与 Policy/YOLO 框架为准：
//   - `builtin:<name>`，<name> ∈ {locked, standard, open, yolo}（A1）：解析到打包的只读 built-in
//     集合（origin=builtin）。未知名称产生列出已知集合的结构化错误。`builtin:` 前缀必填；裸 canonical
//     名称永不解析（禁止 shadowing）。
//   - 相对 custom path（A2）：相对于声明它的 RigSpec 目录解析（origin=custom）；绝对路径、`..` 穿越、
//     空 segment 均产生结构化错误（属于 spec 缺陷，不回退到 floor）。复用已有的安全路径约束
//     （path-safety.validateSafePath）。
//   - `none` = 已记录的有意选择（RULED-FORM-deliberate-none-2026-08-04，sha256 5f37e40f——
//     A3 预留由自身修订激活）：第三种 origin deliberate_none，从不解析到文件，posture 与缺席时相同
//     （floor）。
//   - 缺席（无值）= floor（如实缺席）；调用方传 undefined，不是错误。
// Built-in ASSET 打包属于后续分支：此处 builtin 解析只处理 REF 语义（前缀→origin），不会读取或要求
// asset 文件存在。

import * as path from "node:path";
import { validateSafePath } from "../path-safety.js";
import { parsePolicySpec, validatePolicySpec } from "./policy-spec.js";
import type { LaunchPosture, PolicySurface } from "./policy-spec.js";

/** 打包的只读 built-in policy 集合（README v4：3 个 Policy-Mode spec + Operator/YOLO）。 */
export const BUILTIN_POLICY_NAMES = ["locked", "standard", "open", "yolo"] as const;
export type BuiltinPolicyName = (typeof BUILTIN_POLICY_NAMES)[number];
/** deliberate_none：裁定修订 5f37e40f——已记录的选择，绝不由文件支撑。 */
export type PolicyRefOrigin = "builtin" | "custom" | "deliberate_none";

const BUILTIN_PREFIX = "builtin:";

export interface ResolvedPolicyRef {
  /** 原样保留的 ref 字符串（随 spec 穿过 state）。 */
  ref: string;
  origin: PolicyRefOrigin;
  /** origin === "builtin" 时存在：经校验的 built-in 名称。 */
  builtinName?: BuiltinPolicyName;
}

function isBuiltinName(name: string): name is BuiltinPolicyName {
  return (BUILTIN_POLICY_NAMES as readonly string[]).includes(name);
}

/**
 * 校验并分类 permission_policy REF。无效 ref 返回结构化错误字符串（无效 ref 是 spec 缺陷，绝不
 * 静默回退到 floor），有效则返回 null。缺席由调用方处理（这里只传存在的值）。`label` 为展示层
 * 错误添加前缀（与 RigSpec 校验约定一致，例如 "permission_policy" / "pods[0].members[1].
 * permission_policy"）。
 */
export function validatePermissionPolicyRef(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${label}：permission_policy 必须是非空字符串 ref`;
  }
  if (value === "none") {
    // 裁定修订（5f37e40f）：A3 预留字面值就是已记录的有意选择——有效；下方处理分类/解析。
    return null;
  }
  if (value.startsWith(BUILTIN_PREFIX)) {
    const name = value.slice(BUILTIN_PREFIX.length);
    if (!isBuiltinName(name)) {
      return `${label}：未知内置策略 '${name}'（已知：${BUILTIN_POLICY_NAMES.join(", ")}）`;
    }
    return null;
  }
  // 防 shadowing（A1："绝不允许 canonical-name shadowing"）：裸 canonical 名称不得伪装为 custom
  // ref，否则会静默错误解析 origin（对 `yolo` 还会静默将 full_bypass 降级为 floor）。要求显式的
  // builtin: 前缀。
  if (isBuiltinName(value)) {
    return `${label}：'${value}' 是 built-in policy 名称——请使用 'builtin:${value}'（builtin: 前缀必填；裸名称永不解析，也不允许 shadowing）`;
  }
  // Custom 相对 ref——沿用既有安全路径约束（拒绝绝对路径和 ..）……
  const pathErr = validateSafePath(value, label);
  if (pathErr) return pathErr;
  // ……再补充 validateSafePath 未覆盖的显式空 segment 拒绝（README v4 A2）。
  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some((seg) => seg.length === 0)) {
    return `${label}：不允许空路径 segment（收到 "${value}"）`;
  }
  // README v4 A2 的逐 segment 字符集（既有 ref 约束，与 rig-context 首日契约同类）：每个 segment
  // 都是单个安全路径组件。
  for (const seg of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg)) {
      return `${label}：路径 segment "${seg}" 违反 ref 字符集（每个 segment 必须匹配 [A-Za-z0-9][A-Za-z0-9._-]*）`;
    }
  }
  return null;
}

/**
 * 分类有效 ref（先调用 validatePermissionPolicyRef）。保留并公开 origin，绝不静默重分类
 *（如实呈现 origin）。对已校验 ref 绝不抛错。
 */
export function classifyPermissionPolicyRef(value: string): ResolvedPolicyRef {
  if (value.startsWith(BUILTIN_PREFIX)) {
    return { ref: value, origin: "builtin", builtinName: value.slice(BUILTIN_PREFIX.length) as BuiltinPolicyName };
  }
  return { ref: value, origin: "custom" };
}

/**
 * 跨重启稳定的已解析 attachment（dev-guard 早期裁定，2026-08-04）：只持久化原始相对 ref 并不足以
 * 完整重启。需同时携带原始 `ref`（用于如实导出和后续 skill apply）、`resolvedTarget`（built-in 的
 * canonical package 标识符；custom 的绝对解析路径）、`declaringDir`（custom）与 `origin`，从而让
 * restore 无需原始内存 RigSpec 即可重开/校验 custom policy，并重新派生 surface + launch_posture。
 */
export interface ResolvedPolicyAttachment {
  /** 原样保留的原始 ref，用于导出与 skill apply。 */
  ref: string;
  origin: PolicyRefOrigin;
  /** origin=builtin：经校验的 built-in 名称。 */
  builtinName?: BuiltinPolicyName;
  /** custom：绝对解析路径。builtin：packaging 分支裁定后的 canonical 已发布 package-copy 路径
   *（PM lane c76c7153）——在此之前缺席；绝不能回显原始 ref 的 `builtin:<name>`（dev-guard 修正 2：
   * ref 会为导出单独持久化，在此重复并非跨重启稳定的 provenance）。 */
  resolvedTarget?: string;
  /** origin=custom：canonical（绝对）RigSpec 声明目录——跨重启稳定的 provenance。 */
  declaringDir?: string;
  /** 内容可解析（custom）或已知（built-in）时的已解析 policy surface。 */
  surface?: PolicySurface;
  /** 每 seat binding 的 flag-surface launch posture（floor | full_bypass）。 */
  launchPosture: LaunchPosture;
  /** Guard 第 2 轮（8232199a）：仅当 custom CONTENT 解析确实成功且语义可用时为 true——解析成功 +
   * 已知 surface +（flag ⇒ 有效 launch_posture）。Restore 仅在此值为 true 时信任重新派生，否则沿用
   * 已持久化 posture。Built-in 始终为 true（由名称派生语义）。 */
  contentResolved: boolean;
}

/** 注入 reader，使解析可测试且模块不与 fs 硬耦合。目标缺失/不可读时抛错（resolver 将其视为建议性
 * floor，并保留 provenance）。 */
export interface PolicyResolveDeps {
  readFile: (absolutePath: string) => string;
}

/**
 * Built-in policy 的 canonical 已发布 package-copy 路径的唯一映射点——PM 已裁定（dev-guard
 * 在 9e94c274、lane c76c7153 的行内 NOT-CLEAR 裁定）：
 *   repo source（未来）： packages/daemon/policies/builtin/<name>.policy.md
 *   provenance target：  policies/builtin/<name>.policy.md（package-relative；运行时 module-relative）
 * 原始 `builtin:<name>` ref 独立保留（如实导出）；此 target 是跨重启稳定的 provenance。Built-in
 * CONTENT 仍属后续分支——此处不读取或复制 asset。
 */
export function builtinPackageTarget(name: BuiltinPolicyName): string {
  return `policies/builtin/${name}.policy.md`;
}

/**
 * 将已校验且存在的 ref（先调用 validatePermissionPolicyRef）解析为跨重启稳定的 attachment。
 * `declaringDir` 是声明 ref 的 RigSpec canonical 目录（custom ref 相对于它解析——README v4 A2）。
 * Flag-surface CONTENT 解析归 CORE 所有（guard 裁定）：custom `surface: flag` policy 的
 * `launch_posture`（floor|full_bypass）在此读取。
 *   - built-in：由名称派生、限定于锁定集合的 posture（yolo → full_bypass，其余 → floor）；保留
 *     origin + canonical `builtin:<name>` target。Package ASSET 是否存在属于后续分支。
 *   - custom：相对于 declaringDir 解析，读取并解析（接缝 A），派生 surface；flag → 对应
 *     launch_posture；config → floor（config-surface CONTENT 应用推迟到 skill，此处不写 config）。
 *     不可读/无效 → 建议性 floor，但仍保留 provenance。
 */
export function resolvePermissionPolicyAttachment(
  ref: string,
  declaringDir: string,
  deps: PolicyResolveDeps,
): ResolvedPolicyAttachment {
  if (ref === "none") {
    // 裁定修订（5f37e40f）：已记录的有意选择。绝不解析到文件（无 resolvedTarget/declaringDir；
    // 'none' 保持不可引用，因此 A3 防抢占边界成立）；posture 与缺席时完全相同（权限增量为零，
    // 整项变更只涉及记录/provenance）。
    return {
      ref,
      origin: "deliberate_none",
      launchPosture: "floor",
      contentResolved: true, // 按构造完全已知语义（与 built-in 相同）。
    };
  }
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const builtinName = ref.slice(BUILTIN_PREFIX.length) as BuiltinPolicyName;
    return {
      ref,
      origin: "builtin",
      builtinName,
      resolvedTarget: builtinPackageTarget(builtinName),
      surface: builtinName === "yolo" ? "flag" : undefined,
      launchPosture: builtinName === "yolo" ? "full_bypass" : "floor",
      contentResolved: true,
    };
  }
  // Custom ref：相对于声明它的 RigSpec 目录解析（绝非 cwd/workspace 根目录）。
  const resolvedTarget = path.resolve(declaringDir, ref);
  let surface: PolicySurface | undefined;
  let launchPosture: LaunchPosture = "floor";
  let contentResolved = false;
  try {
    const parsed = parsePolicySpec(deps.readFile(resolvedTarget));
    if (!("error" in parsed)) {
      const s = parsed.frontmatter["surface"];
      if (s === "flag" || s === "config") surface = s;
      // R2 HIGH-2：只有完整封闭的接缝 A frontmatter 契约校验通过时，content 才算已解析
      //（validatePolicySpec：适合 surface 的必填字段、action-list 结构、schema version、description
      // 等）。不得让可解析但无效的内容优先于已持久化 posture；这里只做建议性读取。
      const contract = validatePolicySpec(parsed.frontmatter);
      if (contract.ok && surface === "flag") {
        const lp = parsed.frontmatter["launch_posture"];
        if (lp === "floor" || lp === "full_bypass") {
          launchPosture = lp;
          contentResolved = true;
        }
      } else if (contract.ok && surface === "config") {
        contentResolved = true; // 有效 config 语义；posture floor 是真实结果。
      }
      // 无效契约或未知 surface → 未解析（建议性 floor，保留 provenance）。
    }
  } catch {
    // 解析时不可读/不可解析 → 建议性 floor；仍保留 ref + provenance。
  }
  return { ref, origin: "custom", resolvedTarget, declaringDir, surface, launchPosture, contentResolved };
}

/**
 * 优先级：member 级 ref 覆盖 rig 级 ref；两者都缺席时为 undefined（= floor）。
 * member > rig > floor（README v4 + IMPL-PLAN）。spec surface 不存在 pod 级别。
 */
export function resolvePermissionPolicyRefValue(
  memberRef: string | null | undefined,
  rigRef: string | null | undefined,
): string | undefined {
  return (memberRef ?? undefined) ?? (rigRef ?? undefined);
}
