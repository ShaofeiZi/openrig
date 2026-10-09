// V1 第 5 阶段 P5-3 —— For You 订阅开关表面。
//
// 按 for-you-feed.md L144–L151 渲染 5 个订阅，呈小型设置样式列表
//（非信息流样式 UX，见 L134-L140 承重约束 SC-16）。每个非强制行点击切换，
// 并写入对应的 feed.subscriptions.* ConfigStore 键。action_required 强制开启
//（L145 —— 承重的人工门禁事项不可关闭），渲染为禁用外观行，带"强制开启"标签。

// OPR.0.4.6.MH2 FR-5（pm-RULED：两处位置）—— 左侧面板 HOSTS 区域：
// 在已发布但未暴露的 OPR.0.4.4.15 写入路径之上，持久化每主机订阅
//（hostSubscriptions / setHostSubscription —— 已完成，勿重建）。
// 页内芯片过滤器（"我当前在看什么"的瞬态过滤）已在 Feed.tsx 中发布；
// 这些开关回答另一个问题：什么在汇入聚合视图。本地项强制开启（fr5a）。
// 仅当存在至少一个远端主机需要治理时才渲染该区域——空注册表保持今日面板不变（零回归）。

import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import { useHosts } from "../../hooks/useHosts.js";

interface ToggleRow {
  toggleKey: "approvals" | "shipped" | "progress" | "auditLog" | null;
  label: string;
  description: string;
  forced?: boolean;
  testId: string;
}

const ROWS: ToggleRow[] = [
  {
    toggleKey: null,
    label: "需要操作",
    description: "需要人工处理的事项",
    forced: true,
    testId: "subscription-toggle-action-required",
  },
  {
    toggleKey: "approvals",
    label: "审批",
    description: "待批准的收尾事项",
    testId: "subscription-toggle-approvals",
  },
  {
    toggleKey: "shipped",
    label: "功能发布",
    description: "切片 / 任务目标交付 + git 标签落地",
    testId: "subscription-toggle-shipped",
  },
  {
    toggleKey: "progress",
    label: "切片进度",
    description: "紧凑进度汇总",
    testId: "subscription-toggle-progress",
  },
  {
    toggleKey: "auditLog",
    label: "审计日志",
    description: "详细流 + 看门狗观察",
    testId: "subscription-toggle-audit-log",
  },
];

export function SubscriptionToggleList() {
  const { state, toggle, isMutating, unavailable, hostSubscriptions, setHostSubscription } =
    useFeedSubscriptions();
  const { data: hostsData } = useHosts();

  // 治理集合 = 注册表主机 ∪ 已持久化订阅行（行可能比注册表项活得更久——
  // 如实渲染，绝不丢弃）。
  const subByHost = new Map(hostSubscriptions.map((h) => [h.hostId, h.enabled]));
  const hostIds = Array.from(
    new Set([...(hostsData?.hosts ?? []).map((h) => h.id), ...hostSubscriptions.map((h) => h.hostId)]),
  ).sort();

  return (
    <div data-testid="subscription-toggle-list" className="font-mono text-xs">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">
        订阅
      </div>
      <ul className="space-y-1">
        {ROWS.map((row) => {
          // 解析此行的当前值。
          const value =
            row.toggleKey === null
              ? state.actionRequired // always true in V1
              : state[row.toggleKey];
          const interactive = !row.forced && !unavailable;
          return (
            <li
              key={row.testId}
              data-testid={row.testId}
              data-on={value ? "true" : "false"}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-on-surface truncate">{row.label}</div>
                <div className="font-mono text-[9px] text-on-surface-variant truncate">
                  {row.description}
                </div>
              </div>
              {row.forced ? (
                <span className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant shrink-0">
                  强制开启
                </span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={value}
                  disabled={!interactive || isMutating}
                  data-testid={`${row.testId}-button`}
                  onClick={() => row.toggleKey && toggle(row.toggleKey)}
                  className={
                    "shrink-0 px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide " +
                    (value
                      ? "border-success text-success"
                      : "border-outline-variant text-on-surface-variant") +
                    (interactive
                      ? " hover:bg-surface-low/60"
                      : " opacity-60 cursor-not-allowed")
                  }
                >
                  {value ? "开" : "关"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {hostIds.length > 0 ? (
        <div data-testid="subscription-host-toggle-list" className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">
            主机
          </div>
          <ul className="space-y-1">
            <li
              data-testid="subscription-host-toggle-local"
              data-on="true"
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="text-on-surface truncate">本机</div>
                <div className="font-mono text-[9px] text-on-surface-variant truncate">
                  本地事项始终显示
                </div>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant shrink-0">
                强制开启
              </span>
            </li>
            {hostIds.map((hostId) => {
              const enabled = subByHost.get(hostId) ?? false;
              const interactive = !unavailable;
              return (
                <li
                  key={hostId}
                  data-testid={`subscription-host-toggle-${hostId}`}
                  data-on={enabled ? "true" : "false"}
                  className="flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-on-surface truncate">{hostId}</div>
                    <div className="font-mono text-[9px] text-on-surface-variant truncate">
                      {enabled ? "正在汇入聚合视图" : "不在信息流中显示"}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    disabled={!interactive || isMutating}
                    data-testid={`subscription-host-toggle-${hostId}-button`}
                    onClick={() => setHostSubscription(hostId, !enabled)}
                    className={
                      "shrink-0 px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide " +
                      (enabled
                        ? "border-success text-success"
                        : "border-outline-variant text-on-surface-variant") +
                      (interactive
                        ? " hover:bg-surface-low/60"
                        : " opacity-60 cursor-not-allowed")
                    }
                  >
                    {enabled ? "开" : "关"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {unavailable ? (
        <p
          data-testid="subscription-toggle-unavailable"
          className="mt-3 font-mono text-[9px] text-on-surface-variant italic"
        >
          设置端点不可达（旧版后台服务 &lt; v0.3.0）。开关显示规范默认值；请通过 CLI 配置：
          <code className="ml-1 text-on-surface">
            zrig config set feed.subscriptions.&lt;kind&gt; true|false
          </code>
        </p>
      ) : null}
    </div>
  );
}
