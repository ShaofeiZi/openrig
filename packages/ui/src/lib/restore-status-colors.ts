/**
 * 将恢复节点的结果状态映射为 Tailwind 文字色类名。
 * 取值词汇：resumed / rebuilt / fresh / failed / n-a（均为协议枚举，保持原值）。
 */
export function getRestoreStatusColorClass(status: string): string {
  switch (status) {
    case "resumed":
      return "text-success";
    case "rebuilt":
      return "text-success";
    case "fresh":
      return "text-foreground-muted";
    case "failed":
      return "text-destructive";
    // 兼容：历史持久化的旧取值
    case "checkpoint_written":
      return "text-success";
    case "fresh_no_checkpoint":
      return "text-foreground-muted";
    default:
      return "text-foreground-muted";
  }
}
