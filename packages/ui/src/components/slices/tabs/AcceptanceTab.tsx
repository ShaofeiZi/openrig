// 切片故事视图 v0 + v1 + UI 增强包 v0 —— 验收标签页。
//
// v0（切片故事视图）：头部进度条 + 从切片的 README / IMPLEMENTATION-PRD /
// PROGRESS.md 拉取的复选框列表。
//
// v1 维度 #3：当 workflow_instance 绑定到切片时，在复选框列表上方
// 渲染当前步骤面板——活动步骤、目标、允许的出口、规格声明的下一步目标。
//
// UI 增强包 v0（第 1A 项）扩展复选框列表：
//   - 复选框药丸（圆角带状态图标：◯ 进行中 / ✓ 已完成 / ⚠ 已阻塞）
//     替代原始 `[ ]` / `[x]` 语法。
//   - 状态筛选芯片（全部 / 进行中 / 已完成 / 已阻塞；默认全部）。
//   - 点击展开行详情面板，突出显示来源文件:行号引用。
//
// 三层组合；PROGRESS.md 解析不变。
//（来自 `## Heading` 节 + `  -` 缩进的层级是直接扩展，
// 一旦后台服务端验收解析器返回每行的 parent_section_heading。）

import { useMemo, useState } from "react";
import type { AcceptanceItem, CurrentStepPayload, SliceDetail } from "../../../hooks/useSlices.js";
import { ToolMark } from "../../graphics/RuntimeMark.js";

type StatusFilter = "all" | "active" | "done" | "blocked";

const FILTERS: StatusFilter[] = ["all", "active", "done", "blocked"];

const FILTER_LABEL_ZH: Record<StatusFilter, string> = {
  all: "全部",
  active: "进行中",
  done: "已完成",
  blocked: "已阻塞",
};

export function AcceptanceTab({ acceptance }: { acceptance: SliceDetail["acceptance"] }) {
  const { totalItems, doneItems, percentage, items, closureCallout, currentStep } = acceptance;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);


  return (
    <div data-testid="acceptance-tab" className="p-4">
      {currentStep && <CurrentStepPanel currentStep={currentStep} />}
      <header className="mb-4">
        <div className="flex items-baseline justify-between">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface">
            验收
          </div>
          <div className="font-mono text-[10px] text-on-surface-variant">
            {doneItems} / {totalItems} ({percentage}%)
          </div>
        </div>
        <div className="mt-2 h-2 w-full bg-surface-low" data-testid="acceptance-progress-bar">
          <div
            className="h-2 bg-emerald-500 transition-all"
            data-testid="acceptance-progress-fill"
            data-percentage={percentage}
            style={{ width: `${percentage}%` }}
          />
        </div>
        {closureCallout && (
          <div
            data-testid="acceptance-closure-callout"
            className="mt-3 border border-outline-variant bg-surface-low px-3 py-2 font-mono text-[10px] text-on-surface"
          >
            {closureCallout}
          </div>
        )}
        {items.length > 0 && (
          <div className="mt-3 flex gap-1" data-testid="acceptance-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                data-testid={`acceptance-filter-${f}`}
                data-active={filter === f}
                onClick={() => setFilter(f)}
                className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.10em] ${
                  filter === f
                    ? "border-on-surface bg-inverse-surface text-background"
                    : "border-outline-variant text-on-surface hover:bg-surface-low"
                }`}
              >
                {FILTER_LABEL_ZH[f]}
              </button>
            ))}
          </div>
        )}
      </header>
      {items.length === 0 ? (
        <div className="font-mono text-[10px] text-on-surface-variant" data-testid="acceptance-empty">
          切片文档中未找到验收项（在 README / IMPLEMENTATION-PRD / PROGRESS / IMPLEMENTATION 中查找 `[ ]` / `[x]` 复选框行）。
        </div>
      ) : filtered.length === 0 ? (
        <div className="font-mono text-[10px] text-on-surface-variant" data-testid="acceptance-filter-empty">
          没有项匹配筛选器 '{FILTER_LABEL_ZH[filter]}'。
        </div>
      ) : (
        <ul className="space-y-1" data-testid="acceptance-list">
          {filtered.map((item, idx) => (
            <AcceptanceRow key={`${item.source.file}:${item.source.line}`} item={item} idx={idx} />
          ))}
        </ul>
      )}
    </div>
  );
}

// v1 维度 #3：当前步骤面板。
function CurrentStepPanel({ currentStep }: { currentStep: CurrentStepPayload }) {
  return (
    <section
      data-testid="acceptance-current-step"
      data-step-id={currentStep.stepId}
      className="mb-6 border border-outline-variant bg-background p-3"
    >
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface">
          当前步骤
        </div>
        <div className="font-mono text-[9px] text-on-surface-variant">
          跳 {currentStep.hopCount} · {currentStep.instanceStatus}
        </div>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          data-testid="acceptance-current-step-id"
          className="font-mono text-[12px] font-bold text-on-surface"
        >
          {currentStep.stepId}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">
          角色：{currentStep.role}
        </span>
      </div>
      {currentStep.objective && (
        <div
          data-testid="acceptance-current-step-objective"
          className="mt-2 whitespace-pre-line font-mono text-[10px] text-on-surface"
        >
          {currentStep.objective}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div data-testid="acceptance-current-step-allowed-exits">
          <div className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant">
            允许的出口
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {currentStep.allowedExits.length === 0 ? (
              <span className="font-mono text-[9px] text-on-surface-variant">（无）</span>
            ) : (
              currentStep.allowedExits.map((exit) => (
                <span
                  key={exit}
                  className="border border-outline-variant bg-surface-lowest px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface"
                >
                  {exit}
                </span>
              ))
            )}
          </div>
        </div>
        <div data-testid="acceptance-current-step-allowed-next-steps">
          <div className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant">
            允许的下一步
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {currentStep.allowedNextSteps.length === 0 ? (
              <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">
                <ToolMark tool="terminal" size="xs" />
                终端
              </span>
            ) : (
              currentStep.allowedNextSteps.map((next) => (
                <span
                  key={next.stepId}
                  data-testid={`acceptance-next-step-${next.stepId}`}
                  className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] text-emerald-900"
                  title={`角色：${next.role}`}
                >
                  {next.stepId}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// UI 增强包 v0（第 1A 项）：复选框药丸行，点击展开详情。
function AcceptanceRow({ item, idx }: { item: AcceptanceItem; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const { pillClass, pillIcon, pillLabel } = pillStyle(item.done);
  return (
    <li
      data-testid={`acceptance-item-${idx}`}
      data-done={item.done}
      className="border-b border-outline-variant"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`acceptance-item-${idx}-toggle`}
        className="flex w-full items-start gap-2 py-1.5 text-left hover:bg-background"
      >
        <span
          data-testid={`acceptance-pill-${idx}`}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${pillClass}`}
          aria-label={pillLabel}
        >
          <span aria-hidden="true">{pillIcon}</span>
          <span>{pillLabel}</span>
        </span>
        <span className="flex-1 font-mono text-[10px] text-on-surface">{item.text}</span>
        <span className="font-mono text-[8px] text-on-surface-variant" title={`${item.source.file}:${item.source.line}`}>
          {item.source.file}:{item.source.line}
        </span>
      </button>
      {expanded && (
        <div
          data-testid={`acceptance-item-${idx}-detail`}
          className="ml-2 mt-1 border-l-2 border-outline-variant bg-background px-3 py-2 font-mono text-[9px] text-on-surface"
        >
          <div>
            <span className="font-bold">来源：</span>{" "}
            <span data-testid={`acceptance-item-${idx}-citation`}>{item.source.file}:{item.source.line}</span>
          </div>
          <div className="mt-1">
            <span className="font-bold">状态：</span> {pillLabel}
          </div>
          <div className="mt-2 whitespace-pre-line text-on-surface">{item.text}</div>
        </div>
      )}
    </li>
  );
}

function filterItems(items: AcceptanceItem[], filter: StatusFilter): AcceptanceItem[] {
  if (filter === "all") return items;
  if (filter === "done") return items.filter((i) => i.done);
  if (filter === "active") return items.filter((i) => !i.done);
  if (filter === "blocked") {
    // v0 的解析器不单独暴露"已阻塞"状态；
    // 已阻塞筛选器显示文本中包含 "blocked" / "park" 提示的项作为启发式。
    // 当解析器升级到 `[~]` 识别时，启发式将优雅降级
    //（筛选器仍按文本模式工作）。
    return items.filter((i) => /\b(blocked|blocker|parked|park)\b/i.test(i.text));
  }
  return items;
}

function pillStyle(done: boolean): { pillClass: string; pillIcon: string; pillLabel: string } {
  if (done) {
    return {
      pillClass: "border-emerald-400 bg-emerald-50 text-emerald-900",
      pillIcon: "✓",
      pillLabel: "已完成",
    };
  }
  return {
    pillClass: "border-outline bg-background text-on-surface",
    pillIcon: "◯",
    pillLabel: "进行中",
  };
}
