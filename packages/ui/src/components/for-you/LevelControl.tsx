// OPR.0.4.1.27 单元 3 —— LevelControl（Option-B 命名等级分段控件）。
//
// 创始者批准的 v5 控件：将 5 个 feed.subscriptions 开关重新构建为
// 一个自然语言等级（全部活动 / 精选 / 只需你处理）。这是在现有开关模型之上的
// 展示层控制——不改变模型。4 个可切换种类映射到预设（feed-levels.ts）；
// action_required 始终开启，不属于任何等级。不匹配任何预设的开关组合读作
// "自定义"（单独开关仍为高级视图）。纸面/墨水/琥珀色调性。

import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import {
  deriveLevel,
  FEED_LEVEL_LABELS,
  type FeedLevel,
  type DerivedLevel,
} from "../../lib/feed-levels.js";

// v5 视觉顺序：从最宽到最窄（左 → 右）。
const ORDER: readonly FeedLevel[] = ["all-activity", "highlights", "needs-you"] as const;

const OPTION_TESTID: Record<FeedLevel, string> = {
  "all-activity": "level-control-option-all-activity",
  "highlights": "level-control-option-highlights",
  "needs-you": "level-control-option-needs-you",
};

function Readout({ level }: { level: DerivedLevel }) {
  if (level === "needs-you") {
    return (
      <>
        <b className="text-on-surface">只需你处理的</b> · 仅显示<span className="text-amber-700">待办事项</span>
      </>
    );
  }
  if (level === "all-activity") {
    return (
      <>
        <b className="text-on-surface">全部活动</b> · <span className="text-amber-700">你需关注的</span> + 所有内容，含审计日志
      </>
    );
  }
  if (level === "highlights") {
    return (
      <>
        <b className="text-on-surface">精选</b> · <span className="text-amber-700">你需关注的</span> + 审批 + 发布 + 进度 · <span className="text-on-surface-variant">审计已隐藏</span>
      </>
    );
  }
  return (
    <>
      <b className="text-on-surface">自定义</b> · 通过下方单独开关设置
    </>
  );
}

export function LevelControl() {
  const { state, setLevel, isMutating, unavailable } = useFeedSubscriptions();
  const current = deriveLevel(state);
  const interactive = !unavailable && !isMutating;

  return (
    <div data-testid="level-control" className="border border-outline-variant bg-background">
      {/* SHOW ME 头部 —— 底线不可协商。 */}
      <div className="flex items-center justify-between bg-inverse-surface text-background font-mono text-[8px] tracking-[0.16em] uppercase px-2.5 py-1.5">
        <span>显示</span>
        <span className="text-on-surface-variant">待办事项始终开启</span>
      </div>

      {/* 分段等级选择器。 */}
      <div className="flex px-2.5 pt-2.5 pb-1">
        {ORDER.map((level) => {
          const active = current === level;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!interactive}
              data-testid={OPTION_TESTID[level]}
              data-active={active ? "true" : "false"}
              onClick={() => setLevel(level)}
              className={
                "flex-1 -ml-px first:ml-0 border px-1 py-2 font-mono text-[9px] uppercase tracking-[0.06em] whitespace-nowrap " +
                (active
                  ? "bg-inverse-surface text-background border-on-surface relative z-10"
                  : "bg-transparent text-on-surface-variant border-outline-variant") +
                (interactive && !active ? " hover:bg-surface-low" : "") +
                (interactive ? "" : " opacity-60 cursor-not-allowed")
              }
            >
              {FEED_LEVEL_LABELS[level]}
            </button>
          );
        })}
      </div>

      {/* 当前等级所显示内容的自然语言说明。 */}
      <div
        data-testid="level-control-readout"
        className="font-mono text-[8px] tracking-[0.04em] text-on-surface-variant leading-relaxed px-2.5 pb-2.5 pt-1.5"
      >
        <Readout level={current} />
      </div>

      {unavailable ? (
        <p
          data-testid="level-control-unavailable"
          className="font-mono text-[8px] text-on-surface-variant italic px-2.5 pb-2.5"
        >
          设置端点不可达（旧版后台服务）。显示规范默认值。
        </p>
      ) : null}
    </div>
  );
}
