// Token / 上下文用量指示器 v0（PL-012）——拓扑图头部用于展示单节点
// 上下文用量等级的小型环形指示器。
//
// 与 PL-019 的活动圆点并排组合。圆点尺寸 + 环形形状保持一致，
// 视觉上读作"两个并行信号"而非相互竞争的徽章。
//
// 等级（与后台服务侧 computeContextHealthSummary 及现有 RigNode 大数字颜色锁定一致）：
//   - >= 80% → 红色  （严重）
//   - >= 60% → 琥珀色（警告）
//   - <  60% → 绿色  （低 / 正常）
//   - 未知 / 无数据 → 灰色虚线
//
// v0 阶段阈值不可配置；若内部试用发现阈值需要由操作者调节，
// 则触发 NAMED v0+1 变更。

interface ContextUsageRingProps {
  percent: number | null | undefined;
  fresh?: boolean;
  availability?: string;
  testIdSuffix?: string;
}

export type ContextUsageTier = "critical" | "warning" | "low" | "unknown";

/** 各等级的中文展示名（仅用于 aria/title 提示，不改变枚举值本身）。 */
const TIER_LABEL_ZH: Record<ContextUsageTier, string> = {
  critical: "严重",
  warning: "警告",
  low: "正常",
  unknown: "未知",
};

export function deriveContextTier(
  percent: number | null | undefined,
  availability?: string,
): ContextUsageTier {
  if (availability !== "known" || typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

const TIER_BORDER_CLASS: Record<ContextUsageTier, string> = {
  critical: "border-red-500",
  warning: "border-amber-500",
  low: "border-emerald-500",
  unknown: "border-outline border-dotted",
};

const TIER_TEXT_CLASS: Record<ContextUsageTier, string> = {
  critical: "text-red-600",
  warning: "text-amber-600",
  low: "text-green-700",
  unknown: "text-on-surface-variant",
};

export function contextUsageTextClass(
  percent: number | null | undefined,
  fresh?: boolean,
  availability?: string | null,
): string {
  const tier = deriveContextTier(percent, availability ?? undefined);
  return `${TIER_TEXT_CLASS[tier]}${tier !== "unknown" && fresh === false ? " opacity-50" : ""}`;
}

export function ContextUsageRing({ percent, fresh, availability, testIdSuffix }: ContextUsageRingProps) {
  const tier = deriveContextTier(percent, availability);
  const titleParts: string[] = [];
  if (tier === "unknown") {
    titleParts.push("上下文：未知");
  } else if (typeof percent === "number") {
    titleParts.push(`上下文：${percent}%（${TIER_LABEL_ZH[tier]}）`);
  }
  if (tier !== "unknown" && fresh === false) titleParts.push("采样已过期");
  const title = titleParts.join(" · ");

  return (
    <span
      data-testid={testIdSuffix ? `context-ring-${testIdSuffix}` : "context-ring"}
      data-context-tier={tier}
      className={`inline-block h-2.5 w-2.5 rounded-full border-2 bg-transparent ${TIER_BORDER_CLASS[tier]}${
        tier !== "unknown" && fresh === false ? " opacity-50" : ""
      }`}
      aria-label={title || "上下文用量"}
      title={title || "上下文用量"}
    />
  );
}
