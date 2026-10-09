/**
 * 验证路径是否安全：必须为相对路径，不能包含路径穿越，也不能是绝对路径。
 * @param path - 待验证的路径
 * @param label - 错误信息中使用的人类可读标签
 * @returns 错误字符串；验证通过时返回 null
 */
export function validateSafePath(path: string, label: string): string | null {
  if (!path || typeof path !== "string") return `${label}：必须提供路径`;
  // Windows 盘符绝对路径。
  if (/^[A-Za-z]:[/\\]/.test(path)) return `${label}：不允许使用绝对路径（收到“${path}”）`;
  // 统一反斜杠，以便检查路径穿越。
  const normalized = path.replace(/\\/g, "/");
  // 绝对路径。
  if (normalized.startsWith("/")) return `${label}：不允许使用绝对路径（收到“${path}”）`;
  // 路径穿越。
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return `${label}：不允许路径穿越（..）（收到“${path}”）`;
  return null;
}
