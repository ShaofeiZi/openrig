/** 原生权限选项是后续启动设置，不表示当前工作状态。 */
export interface NativePermissionSelection {
  runtime: "codex" | "claude-code";
  mode: string;
}

/** 托管启动接线缺失时，绝不能回退到后台服务本地帮助。 */
export async function unresolvedClaudePermissionModes(): Promise<string[] | null> {
  throw new Error("Claude 席位启动上下文尚未解析；原生模式支持不可用。由于没有安全回退，已拒绝选择或启动。");
}

export function validateNativePermissionSelection(
  runtime: string,
  mode: string,
  supportedClaudeModes: readonly string[] | null = null,
): NativePermissionSelection {
  if (runtime !== "codex" && runtime !== "claude-code") {
    throw new Error(`运行时 '${runtime}' 不支持按席位设置权限模式。Pi 资源信任是独立设置。`);
  }
  if (mode === "floor" || mode === "full_bypass") return { runtime, mode };
  if (runtime === "codex") throw new Error("Codex 权限模式必须是 floor 或 full_bypass（也可使用 inherit 清除选择）。");
  // 只接受已安装执行工具明确公布且可安全传入 shell 的选项。
  if (!supportedClaudeModes) throw new Error("Claude 权限选项不可用；选择未更改。");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(mode) || !supportedClaudeModes.includes(mode)) {
    throw new Error(`已安装的执行工具不支持 Claude 权限模式 '${mode}'。`);
  }
  return { runtime, mode };
}

export function permissionBindingOverride(selection: NativePermissionSelection | null): {
  launchPosture?: "floor" | "full_bypass";
  permissionMode?: string;
} {
  if (!selection) return {};
  if (selection.mode === "floor" || selection.mode === "full_bypass") return { launchPosture: selection.mode };
  if (selection.runtime !== "claude-code") throw new Error("持久化的原生权限选择无效。");
  return { permissionMode: selection.mode };
}
