// OPR.0.4.8.2——OpenRig YOLO 模式（选择启用，默认关闭）。
//
// 一个简单、确定性的设置，仅作用于稳定的启动标志界面（依据创始人的双界面规则：启动标志可由
// 确定性代码决定；配置文件策略不可如此）。开启时，每个托管席位都以其 harness 最宽松的启动标志
// 启动：
//   - Claude：--dangerously-skip-permissions（绕过权限）
//   - Codex:  -s danger-full-access           （最宽松 sandbox；关闭时的 floor 是显式
//             -s workspace-write，而不是 harness 默认值）
//   - Pi:     --approve                       （完全 RESOURCE TRUST；Pi 的 --approve/
//             --no-approve 管理 RESOURCE TRUST，而非 permission policy）
// 关闭时（默认），席位继续以可用性 floor 启动，行为不变。YOLO 路径不写任何配置文件，只选择
// 启动标志。通过 OPENRIG_YOLO 环境设置选择启用。（零权限配置写入属性针对 Claude/Codex
// permission policy；Pi 使用 resource trust。）

/** OPR.0.4.8.3 接缝 B：席位已解析的 permission-policy 姿态。存在时，它是该席位的权威，
 * 会双向覆盖 OPENRIG_YOLO 环境读取（附加 builtin:locked 时，即使全局 YOLO 开启也保持 floor；
 * 附加自定义 full_bypass 标志策略时，无需环境开关即可提升席位）。缺失 = 未附加策略 → 继续采用
 * 环境决策（0.4.8.2 行为不变）。 */
export type ResolvedLaunchPosture = "floor" | "full_bypass";

export function yoloEnabled(
  env: NodeJS.ProcessEnv = process.env,
  resolvedPosture?: ResolvedLaunchPosture,
): boolean {
  if (resolvedPosture) return resolvedPosture === "full_bypass";
  const v = env.OPENRIG_YOLO;
  return v === "1" || v === "true";
}

// ── 每个 harness 的唯一启动姿态决策——用于所有托管启动路径（fresh、resume、fork），使 floor
//（关闭）与最宽松姿态（开启）保持一致，绝不依赖路径。注意，不同 harness 的开启姿态不同：
// Claude/Codex = 绕过权限；Pi = 完全 RESOURCE TRUST（--approve），并非 permission policy。──

/** Claude 启动姿态标志：floor `--permission-mode acceptEdits`，或完全 bypass
 *（全局 YOLO，或逐席位解析的 full_bypass 策略附加项）。 */
export function claudePostureFlag(
  env: NodeJS.ProcessEnv = process.env,
  resolvedPosture?: ResolvedLaunchPosture,
  permissionMode?: string,
): string {
  if (permissionMode !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(permissionMode)) throw new Error("Claude permission mode 无效");
    return `--permission-mode ${permissionMode}`;
  }
  return yoloEnabled(env, resolvedPosture) ? "--dangerously-skip-permissions" : "--permission-mode acceptEdits";
}

/**
 * Codex 启动姿态片段（包含前导空格），应用于所有托管 Codex 路径（fresh/resume/native-fork）。
 * `profileArg` 是已格式化的 ` -p <profile>` 字符串或 ""。
 * - YOLO 开启 → ` -s danger-full-access`（最宽松 sandbox），即使有具名 profile 也覆盖。
 * - 关闭 + 具名 profile → 使用 profile（由其管理自身 sandbox）。
 * - 关闭 + 无 profile → OpenRig 显式的仅工作区 floor ` -s workspace-write`。
 * 显式解析的 full_bypass 同时选择 sandbox 和批准行为。旧版仅环境变量 YOLO 路径仍只影响
 * sandbox；未选择时的默认值不变。
 */
export function codexPostureArg(
  profileArg: string,
  env: NodeJS.ProcessEnv = process.env,
  resolvedPosture?: ResolvedLaunchPosture,
): string {
  if (resolvedPosture === "full_bypass") return " -s danger-full-access -a never";
  if (yoloEnabled(env, resolvedPosture)) return " -s danger-full-access";
  return profileArg ? profileArg : " -s workspace-write";
}

/** Pi RESOURCE TRUST（Pi 的 --approve/--no-approve 管理资源信任，不是 permission policy）：
 * YOLO 强制使用 `approve`；否则使用已配置姿态（默认 `no-approve`）。 */
export function piTrust(
  configured: "approve" | "no-approve" | undefined,
  env: NodeJS.ProcessEnv = process.env,
  resolvedPosture?: ResolvedLaunchPosture,
): "approve" | "no-approve" {
  // Pi 术语规则：这是 RESOURCE TRUST，不是 permission policy；解析出的 full_bypass 策略与
  // 全局 YOLO 一样强制完全资源信任。
  return yoloEnabled(env, resolvedPosture) ? "approve" : configured ?? "no-approve";
}

/**
 * OPR.0.5.3.1——Claude classic-renderer 启动环境前缀。
 *
 * Claude Code 的全屏渲染器绘制到终端备用屏幕，不产生 scrollback；因此 tmux capture-pane
 * 无内容可存，`rig transcript` 会变得稀薄。以 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 启动会
 * 强制 classic renderer，恢复原生 scrollback（以及同 pane handover 的滚动保留）。应用于所有
 * 托管 Claude 启动路径（fresh/resume/fork/restore），使行为统一且不依赖路径；镜像
 * claudePostureFlag 模式。
 *
 * 默认开启。配置覆盖：将 OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN 设为 0（或 "false"）可重新
 * 选择全屏渲染器（明确放弃 scrollback）。
 *
 * 返回要加在 `claude` 启动命令前的命令前缀（"VAR=1 "，含尾随空格）；禁用时返回 ""
 *（此时命令与 OPR.0.5.3.1 之前逐字节一致）。
 */
export function claudeClassicRendererEnvPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN;
  return v === "0" || v === "false" ? "" : "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ";
}
