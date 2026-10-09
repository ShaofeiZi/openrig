/**
 * 将节点状态映射为 Tailwind 背景色类名。状态值为协议枚举，保持原值不变。
 */
export function getStatusColorClass(status: string | null): string {
  switch (status) {
    case "running":
      return "bg-success";
    case "idle":
      return "bg-foreground-muted";
    case "exited":
      return "bg-destructive";
    case "detached":
      return "bg-warning";
    case "unknown":
    default:
      return "bg-foreground-muted/50";
  }
}
