/**
 * 把实例化节点的结果状态映射为 Tailwind 文字颜色类。
 * 这些状态与恢复状态、运行时节点状态都不同。
 * 实例化状态:launched、failed。
 */
export function getInstantiateStatusColorClass(status: string): string {
  switch (status) {
    case "launched":
      return "text-success";
    case "failed":
      return "text-destructive";
    default:
      return "text-foreground-muted";
  }
}
