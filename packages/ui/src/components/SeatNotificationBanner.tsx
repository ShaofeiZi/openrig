// V0.3.1 切片 25 后续 —— 席位详情通知横幅。
//
// 在"概览"标签页的 SeatOverviewTable 上方渲染详细活动 / 待关注消息，
// 让操作者立即看到。无活动消息时隐藏，不占空间。
//
// NodeDetailData 上的真相来源字段：
//   - latestError（string | null）—— 展示启动失败错误文本及后台服务
//     缓存的其他运行时错误。
//   - recoveryGuidance（{summary, commands[], notes[]} | null）——
//     后台服务整理的引导块，用于帮助席位摆脱卡住状态。
//   - startupStatus（"attention_required" | "failed" | ...）——
//     待关注/失败状态驱动视觉变体 + 标题。
//
// 同样的数据在"详情"标签页中由 StatusSection 以更完整形式渲染；
// 本横幅是为概览标签页精简前置展示标题级信息。两个表面读取同一份
// NodeDetailData 字段——没有并行流水线。

import { Alert, AlertDescription, AlertTitle } from "./ui/alert.js";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";

interface SeatNotificationBannerProps {
  data: NodeDetailData;
}

function headlineFor(data: NodeDetailData): string | null {
  if (data.startupStatus === "failed") return "启动失败";
  if (data.startupStatus === "attention_required") return "需要关注";
  if (data.latestError) return "错误";
  return null;
}

function variantFor(data: NodeDetailData): "default" | "destructive" {
  if (data.startupStatus === "failed") return "destructive";
  if (data.latestError && data.startupStatus !== "attention_required") return "destructive";
  return "default";
}

export function SeatNotificationBanner({ data }: SeatNotificationBannerProps) {
  const headline = headlineFor(data);

  // V0.3.1 切片 25 后续-2 —— 横幅仅在真正告警状态下渲染
  //（failed / attention_required / latestError）。仅有通用
  // recoveryGuidance 不满足条件；它是恢复步骤文档，不是待关注事件。
  // 后续-1 在仅有 guidance 时也渲染横幅，导致每个正常席位都出现误报——
  // 调度已将意图修正为仅告警时展示。
  if (!headline) return null;

  const hasError = !!data.latestError;
  const hasGuidance = !!data.recoveryGuidance;

  return (
    <Alert
      data-testid="seat-notification-banner"
      data-startup-status={data.startupStatus ?? "unknown"}
      variant={variantFor(data)}
    >
      <AlertTitle
        data-testid="seat-notification-headline"
        className="font-mono text-[11px] uppercase tracking-[0.08em]"
      >
        {headline}
      </AlertTitle>
      {hasError ? (
        <AlertDescription
          data-testid="seat-notification-error"
          className="font-mono text-[10px]"
        >
          {data.latestError}
        </AlertDescription>
      ) : null}
      {hasGuidance && data.recoveryGuidance ? (
        <AlertDescription
          data-testid="seat-notification-guidance"
          className="mt-1 font-mono text-[10px] text-on-surface"
        >
          {data.recoveryGuidance.summary}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
