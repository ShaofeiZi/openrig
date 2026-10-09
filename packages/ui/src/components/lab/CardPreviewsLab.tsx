// V0.3.1 slice 21 onboarding-conveyor。
//
// /lab/card-previews——所有为你推荐卡片类别变体的可视化画廊，带示例数据。
// 同时充当设计师参考 + 回归界面（实时 feed 与本画廊渲染同一批卡片组件，
// 故视觉偏差立即可见）。
//
// 2026-05-15——按创始人反馈移除外层 VellumCard 画廊包裹。每张卡片
// 已有自己的环境阴影 + 新 vellum 协调设计的角括号，再把每张卡片包进另一个
// VellumCard 就是“卡上卡”的视觉。区块标签现在以朴素的旁注标题坐在每张卡片上方。

import {
  ApprovalCard,
  ConceptCard,
  IncidentCard,
  ProgressCard,
  ShippedCard,
} from "../feed/cards/storytelling-cards.js";
import { EmptyState } from "../ui/empty-state.js";

export function CardPreviewsLab() {
  return (
    <div className="mx-auto max-w-5xl space-y-10 px-6 py-10" data-testid="card-previews-lab">
      <header className="space-y-2">
        <h1 className="font-mono text-[12px] uppercase tracking-[0.18em] text-on-surface-variant">
          /lab/card-previews
        </h1>
        <p className="font-mono text-[11px] text-on-surface">
          为你推荐卡片类别变体的可视化画廊。每个区块渲染实时 feed 所用的
          同一卡片组件，并带示例数据。
        </p>
      </header>

      <SectionLabel
        title="已交付"
        description="切片合并与汇总视图。在切片成功关闭、动态向下游操作者展示时使用。"
      />
      <ShippedCard
        source={{
          sliceId: "first-conveyor-run",
          title: "首次传送带运行——已交付",
          oneLiner: "切片在 b71cddf 合并。4 个提交与 1 个校验包。",
          sections: [
            { number: 1, heading: "Lint 解析并校验条目", summary: "12 个测试通过；处理 UTF-8 边界情况。" },
            { number: 2, heading: "评审通过，仅一处关切", summary: "组合字符边界在中途处理。" },
            { number: 3, heading: "已采集校验包", summary: "CLI 输出截图与差异渲染。" },
          ],
        }}
      />

      <SectionLabel
        title="事件 / 待处理动作"
        description="进行中或近期事件的时间线界面。用 status='warning' 或 'danger' 展示待关注；'info' 表示信息性；'muted' 表示已解决。"
      />
      <IncidentCard
        source={{
          sliceId: "auth-bearer-tailscale-trust",
          title: "Auth bearer tailscale 信任——需关注",
          oneLiner: "评审在 fix-1 标记 loopback-only 默认；在 fix-2 已修复。",
          status: "warning",
          recentEntries: [
            { time: "13:42", title: "评审提出阻塞性关切", status: "danger" },
            { time: "14:01", title: "驱动方前向修复已划定范围", status: "info" },
            { time: "14:38", title: "前向修复已落地；门禁全绿", status: "success" },
          ],
        }}
      />

      <SectionLabel
        title="进展"
        description="任务级进度卡，带百分比和活动切片上下文。在任务生命周期中使用，使操作者无需打开任务页即可了解情况。"
      />
      <ProgressCard
        source={{
          missionId: "release-0.3.1",
          title: "版本 0.3.1——进行中",
          oneLiner: "第 3a 与 3b 波次已派发；多个切片正在评审。",
          percent: 62,
          nextStep: "design-reviewer 对切片 21 叙述语调的审计",
          activeSlice: {
            id: "slice-21-onboarding-conveyor",
            label: "slice-21-onboarding-conveyor",
            status: "in-progress",
          },
        }}
      />

      <SectionLabel
        title="审批 / 待处理动作"
        description="需要操作手决策的界面。渲染 qitem 上下文 + 两条动作路径（批准 / 拒绝），供操作手选择。"
      />
      <ApprovalCard
        source={{
          qitemId: "qitem-20260511201234-abcdef01",
          title: "Auth bearer tailscale 信任——是否批准合并？",
          oneLiner: "所有门禁全绿；合并需操作手签批。",
          bodyPreview: "三重防护 CLEAR。velocity-qa VM 走查通过。可合并到 main。",
          drillInHref: "/project/slice/auth-bearer-tailscale-trust",
          onApprove: () => {},
          onDeny: () => {},
        }}
      />

      <SectionLabel
        title="概念 / 观察"
        description="发现 / 实验室 / 草稿本界面。用于尚不可行动的观察、草稿想法或对比预览。"
      />
      <ConceptCard
        source={{
          sliceId: "concept-storytelling-primitives",
          title: "叙事原语——概念",
          oneLiner: "可用类别框架原语取代一次性卡片组件。",
          comparePreview: [
            { label: "卡片类别", valueOld: "5 个组件", valueNew: "1 个类别框架 + 5 个来源" },
            { label: "视觉差异", valueOld: "随时间漂移", valueNew: "集中的强调色 token" },
            { label: "维护", valueOld: "逐个改组件", valueNew: "只改一次类别框架" },
          ],
        }}
      />

      <SectionLabel
        title="空态"
        description="无事件符合条件时，为你推荐 feed 的展示。跨界面可复用；EmptyState 原语是规范模式。"
      />
      <EmptyState
        label="全部处理完毕"
        description="无新事件。启动一个工作组或声明一个切片来填充此动态。"
        variant="card"
        testId="card-previews-empty-state"
      />
    </div>
  );
}

function SectionLabel({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1 pt-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface">{title}</h2>
      <p className="font-mono text-[10px] text-on-surface-variant max-w-3xl">{description}</p>
    </div>
  );
}
