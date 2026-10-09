import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CirclePlus,
  Clock,
  FileImage,
  GitBranch,
  History,
  MessageSquareText,
  PackageCheck,
  Route,
  Send,
  UserRound,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { VellumCard } from "../ui/vellum-card.js";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

interface Token {
  label: string;
  tone: Tone;
  icon?: LucideIcon;
}

const toneClass: Record<Tone, string> = {
  neutral: "border-outline-variant bg-surface-lowest/65 text-on-surface",
  info: "border-sky-300 bg-sky-50/70 text-sky-800",
  success: "border-emerald-300 bg-emerald-50/70 text-emerald-800",
  warning: "border-amber-300 bg-amber-50/80 text-amber-800",
  danger: "border-rose-300 bg-rose-50/75 text-rose-800",
};

const eventTokens: Token[] = [
  { label: "队列已创建", tone: "info", icon: CirclePlus },
  { label: "移交", tone: "neutral", icon: Send },
  { label: "已认领", tone: "warning", icon: Clock },
  { label: "已完成", tone: "success", icon: CheckCircle2 },
  { label: "需人工动作", tone: "danger", icon: CircleAlert },
  { label: "已交付", tone: "success", icon: PackageCheck },
];

const tagTokens: Token[] = [
  { label: "idea-ledger", tone: "neutral" },
  { label: "cycle-4", tone: "info" },
  { label: "proof", tone: "success" },
  { label: "urgent", tone: "danger" },
  { label: "human-review", tone: "warning" },
];

function Pill({ token, compact = false }: { token: Token; compact?: boolean }) {
  const Icon = token.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border font-mono uppercase tracking-[0.10em]",
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[9px]",
        toneClass[token.tone],
      )}
    >
      {Icon ? <Icon className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} strokeWidth={1.6} /> : null}
      {token.label}
    </span>
  );
}

function ActorChip({
  kind,
  label,
  muted,
}: {
  kind: "human" | "agent";
  label: string;
  muted?: boolean;
}) {
  const Icon = kind === "human" ? UserRound : Bot;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px]",
        muted ? "border-outline-variant bg-surface-lowest/45 text-on-surface-variant" : "border-outline-variant bg-surface-lowest/45 text-on-surface",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function DateChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 border border-outline-variant bg-surface-lowest/55 px-1.5 py-0.5 font-mono text-[9px] text-on-surface-variant">
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {label}
    </span>
  );
}

function FlowStrip() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ActorChip kind="agent" label="orch.lead@openrig-velocity" />
      <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" strokeWidth={1.4} />
      <ActorChip kind="agent" label="driver@openrig-velocity" />
      <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" strokeWidth={1.4} />
      <ActorChip kind="human" label="human@host" />
    </div>
  );
}

function ProofStrip() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {["for-you-human-and-shipped.png", "project-overview-missions.png", "project-triage-slice.png"].map((name) => (
        <div key={name} className="border border-outline-variant bg-surface-low/80">
          <div className="flex aspect-[4/3] items-center justify-center bg-surface-lowest/65 text-on-surface-variant">
            <FileImage className="h-7 w-7" strokeWidth={1.2} />
          </div>
          <div className="truncate border-t border-outline-variant px-1 py-0.5 font-mono text-[8px] text-on-surface-variant">
            {name}
          </div>
        </div>
      ))}
    </div>
  );
}

function CandidateCard({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <VellumCard
      as="section"
      className="bg-surface-lowest/65 backdrop-blur-sm"
      header={<span className="uppercase tracking-[0.16em]">{label}</span>}
    >
      <div className="space-y-4 p-4">
        <p className="font-mono text-[10px] leading-relaxed text-on-surface">{description}</p>
        {children}
      </div>
    </VellumCard>
  );
}

function FeedTreatment({ dense = false }: { dense?: boolean }) {
  return (
    <article className={cn("border border-outline-variant bg-surface-lowest/60 backdrop-blur-sm hard-shadow", dense ? "p-3" : "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Pill token={{ label: "待处理动作", tone: "danger", icon: CircleAlert }} compact={dense} />
          <h3 className="font-mono text-sm text-on-surface">评审 demo-seed 分流校验包</h3>
        </div>
        <DateChip label="今天 16:18" />
      </div>
      <p className="mt-3 whitespace-pre-line font-mono text-[11px] leading-relaxed text-on-surface">
        评审校验包截图，确认已交付 slice 已就绪，然后批准或带意见退回。
      </p>
      <div className="mt-3">
        <FlowStrip />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {tagTokens.slice(0, 4).map((token) => <Pill key={token.label} token={token} compact />)}
      </div>
    </article>
  );
}

function StoryTreatment() {
  return (
    <article className="relative border border-outline-variant bg-surface-lowest/60 p-4 hard-shadow backdrop-blur-sm">
      <div className="absolute left-5 top-12 bottom-5 w-px bg-surface-highest" />
      <div className="relative space-y-5 pl-8">
        {[
          { token: eventTokens[5]!, title: "slice 已随校验包交付", body: "分流 slice 已关闭，并附带截图、队列上下文与校验说明。" },
          { token: eventTokens[3]!, title: "实现已完成", body: "驱动方完成 UI 环节，并把校验交给 guard 与 QA。" },
          { token: eventTokens[1]!, title: "工作已路由待评审", body: "队列条目带针对性检查从驱动方移到 guard。" },
        ].map((step) => {
          const Icon = step.token.icon ?? History;
          return (
            <div key={step.title} className="relative">
              <span className="absolute -left-[38px] top-0 flex h-5 w-5 items-center justify-center border border-outline-variant bg-surface-lowest text-on-surface">
                <Icon className="h-3 w-3" strokeWidth={1.5} />
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Pill token={step.token} compact />
                <DateChip label="12 分钟前" />
              </div>
              <h4 className="mt-2 font-mono text-[12px] text-on-surface">{step.title}</h4>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-on-surface">{step.body}</p>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function QueueTreatment() {
  return (
    <div className="divide-y divide-outline-variant border border-outline-variant bg-surface-lowest/55 backdrop-blur-sm">
      {[
        { token: eventTokens[4]!, title: "需要审批", body: "评审校验截图并批准发布就绪。", actor: "human@host" },
        { token: eventTokens[2]!, title: "QA 已认领", body: "VM 校验正进行中，基于当前工作树源码。", actor: "velocity-qa" },
        { token: eventTokens[1]!, title: "路由到 guard", body: "对纯 UI diff 与源码扫描做窄范围审查。", actor: "redo3-guard-3" },
      ].map((item) => (
        <div key={item.title} className="grid gap-3 p-3 sm:grid-cols-[auto_1fr_auto]">
          <Pill token={item.token} compact />
          <div className="min-w-0">
            <div className="font-mono text-[12px] text-on-surface">{item.title}</div>
            <div className="mt-1 font-mono text-[10px] leading-relaxed text-on-surface">{item.body}</div>
          </div>
          <ActorChip kind={item.actor.includes("human") ? "human" : "agent"} label={item.actor} muted />
        </div>
      ))}
    </div>
  );
}

export function ProjectGraphicsPreview() {
  return (
    <div className="paper-grid min-h-full p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="border border-outline-variant bg-surface-lowest/60 p-4 font-mono backdrop-blur-sm hard-shadow">
          <div className="text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">
            项目图形包预览
          </div>
          <h1 className="mt-2 text-xl uppercase tracking-[0.14em] text-on-surface">
            队列、故事与校验卡语言
          </h1>
          <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-on-surface">
            隐藏预览路由，用于在把系统应用到为你推荐、故事、队列与工作范围汇总之前，
            挑选元数据徽章、动作 chip、流程箭头与校验卡密度。
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <CandidateCard
            label="A / 紧凑台账"
            description="小 pill 与克制的图标。在密度重要、队列卡需要像工作台账一样扫读时最佳。"
          >
            <FeedTreatment dense />
            <QueueTreatment />
          </CandidateCard>

          <CandidateCard
            label="B / 叙事轨"
            description="故事优先布局，事件图标在垂直轨上。适合展示工作如何从想法走到校验。"
          >
            <StoryTreatment />
            <ProofStrip />
          </CandidateCard>

          <CandidateCard
            label="C / 动作看板"
            description="更大胆的卡片，带明确状态、角色与校验缩略图。适合为你推荐与审批界面。"
          >
            <FeedTreatment />
            <div className="flex flex-wrap gap-1.5">
              {eventTokens.map((token) => <Pill key={token.label} token={token} />)}
            </div>
          </CandidateCard>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <VellumCard as="section" className="bg-surface-lowest/65 backdrop-blur-sm" header="事件徽章词表">
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {eventTokens.map((token) => (
                <div key={token.label} className="border border-outline-variant bg-surface-lowest/55 p-3">
                  <Pill token={token} />
                  <div className="mt-2 font-mono text-[10px] leading-relaxed text-on-surface">
                    {token.label === "队列已创建" ? "一个工作项进入系统。" : null}
                    {token.label === "移交" ? "所有权从一个角色移交给另一个。" : null}
                    {token.label === "已认领" ? "某角色正在主动处理该条目。" : null}
                    {token.label === "已完成" ? "指派的工作项已关闭。" : null}
                    {token.label === "需人工动作" ? "需要某人批准、拒绝或路由。" : null}
                    {token.label === "已交付" ? "slice 已关闭并附带证据。" : null}
                  </div>
                </div>
              ))}
            </div>
          </VellumCard>

          <VellumCard as="section" className="bg-surface-lowest/65 backdrop-blur-sm" header="辅助 chip">
            <div className="space-y-4 p-4">
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">标签</div>
                <div className="flex flex-wrap gap-1.5">
                  {tagTokens.map((token) => <Pill key={token.label} token={token} />)}
                </div>
              </div>
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">角色</div>
                <div className="flex flex-wrap gap-1.5">
                  <ActorChip kind="human" label="human@host" />
                  <ActorChip kind="agent" label="driver@openrig-velocity" />
                  <ActorChip kind="agent" label="guard@openrig-velocity" muted />
                </div>
              </div>
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">工作范围</div>
                <div className="flex flex-wrap gap-1.5">
                  <Pill token={{ label: "工作区", tone: "neutral", icon: Route }} />
                  <Pill token={{ label: "任务", tone: "info", icon: GitBranch }} />
                  <Pill token={{ label: "slice", tone: "success", icon: MessageSquareText }} />
                </div>
              </div>
            </div>
          </VellumCard>
        </section>
      </div>
    </div>
  );
}
