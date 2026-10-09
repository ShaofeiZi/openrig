// V1 attempt-3 Phase 5 P5-3 —— For You 信息流订阅状态 hook。
//
// 从 /api/config 读取 5 个 feed.subscriptions.* 白名单键，并提供一个经
// /api/config/<key> 写回的切换函数。依 for-you-feed.md L144-L151：
//   - action_required 被强制开启（依 L145 不可关闭；本 hook 驱动的 UI 表面
//     从不为该键渲染可交互开关）。
//   - approvals / shipped / progress 默认开启。
//   - audit_log 默认关闭。
//
// SC-29 例外范围（声明于 Phase 5 ACK §5 DRIFT P5-D2）：同 Phase 4 ConfigStore
// 白名单例外；仅白名单增量新增。

import { useSettings, useSetSetting } from "./useSettings.js";
import type { FeedCardKind } from "../lib/feed-classifier.js";
import { levelToToggles, type FeedLevel } from "../lib/feed-levels.js";

export interface FeedSubscriptionState {
  actionRequired: boolean;
  approvals: boolean;
  shipped: boolean;
  progress: boolean;
  auditLog: boolean;
}

export type FeedSubscriptionToggleKey =
  | "approvals"
  | "shipped"
  | "progress"
  | "auditLog";

const TOGGLE_KEY_TO_CONFIG_KEY: Record<FeedSubscriptionToggleKey, string> = {
  approvals: "feed.subscriptions.approvals",
  shipped: "feed.subscriptions.shipped",
  progress: "feed.subscriptions.progress",
  auditLog: "feed.subscriptions.audit_log",
};

const DEFAULTS: FeedSubscriptionState = {
  actionRequired: true,
  approvals: true,
  shipped: true,
  progress: true,
  auditLog: false,
};

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return fallback;
}

/** OPR.0.4.4.15 —— 每主机的合并信息流订阅（G15-P1 动态键类，由后台服务配置列表增量枚举）。 */
export interface HostSubscription {
  hostId: string;
  enabled: boolean;
}

export interface UseFeedSubscriptionsResult {
  state: FeedSubscriptionState;
  /** 切换一个非强制订阅。action_required 被强制开启、不可切换——
   *  调用 toggle("actionRequired") 刻意不在 API 内。 */
  toggle: (key: FeedSubscriptionToggleKey) => void;
  /** 应用一个命名层级（OPR.0.4.1.27）：把 4 个可开关种类写到该层级预设，
   *  仅写入发生变化的键。action_required 被下限开启、从不写入。在既有模型之上做展示。 */
  setLevel: (level: FeedLevel) => void;
  /** OPR.0.4.4.15 —— 已持久化的每主机合并信息流订阅。 */
  hostSubscriptions: HostSubscription[];
  /** ≥1 个远程主机订阅被启用时为真（聚合轮询开关——false = 零配置，现有协议不变）。 */
  anyRemoteEnabled: boolean;
  /** 写入一个每主机订阅键（动态类）。 */
  setHostSubscription: (hostId: string, enabled: boolean) => void;
  /** 底层 setSetting 变更进行中时为真。 */
  isMutating: boolean;
  /** 后台服务不暴露 /api/config 时为真（旧版 v0.2.0）。 */
  unavailable: boolean;
}

export function useFeedSubscriptions(): UseFeedSubscriptionsResult {
  const { data, error } = useSettings();
  const setSetting = useSetSetting();

  const settings = data?.settings as Record<string, { value: unknown }> | undefined;
  const unavailable = !!error || !settings;

  const state: FeedSubscriptionState = unavailable
    ? DEFAULTS
    : {
        actionRequired: readBool(
          settings?.["feed.subscriptions.action_required"]?.value,
          DEFAULTS.actionRequired,
        ),
        approvals: readBool(
          settings?.["feed.subscriptions.approvals"]?.value,
          DEFAULTS.approvals,
        ),
        shipped: readBool(
          settings?.["feed.subscriptions.shipped"]?.value,
          DEFAULTS.shipped,
        ),
        progress: readBool(
          settings?.["feed.subscriptions.progress"]?.value,
          DEFAULTS.progress,
        ),
        auditLog: readBool(
          settings?.["feed.subscriptions.audit_log"]?.value,
          DEFAULTS.auditLog,
        ),
      };

  const toggle = (toggleKey: FeedSubscriptionToggleKey) => {
    const configKey = TOGGLE_KEY_TO_CONFIG_KEY[toggleKey];
    const current = state[toggleKey];
    setSetting.mutate({
      key: configKey as Parameters<typeof setSetting.mutate>[0]["key"],
      value: current ? "false" : "true",
    });
  };

  // OPR.0.4.4.15 —— 每主机合并信息流订阅（动态键类）。由后台服务增量枚举；
  // 缺失/旧版后台服务退化为空列表（零配置 = 今天的行为完全一致）。
  const hostSubscriptions: HostSubscription[] = data?.feedHostSubscriptions ?? [];
  const anyRemoteEnabled = hostSubscriptions.some((h) => h.enabled);
  const setHostSubscription = (hostId: string, enabled: boolean) => {
    setSetting.mutate({
      key: `feed.subscriptions.${hostId}.enabled` as Parameters<typeof setSetting.mutate>[0]["key"],
      value: enabled ? "true" : "false",
    });
  };

  const setLevel = (level: FeedLevel) => {
    const target = levelToToggles(level);
    (Object.keys(TOGGLE_KEY_TO_CONFIG_KEY) as FeedSubscriptionToggleKey[]).forEach((key) => {
      // 只写入实际变化的键——action_required 不是切换键（TOGGLE_KEY_TO_CONFIG_KEY 不含它），故从不触及。
      if (state[key] === target[key]) return;
      setSetting.mutate({
        key: TOGGLE_KEY_TO_CONFIG_KEY[key] as Parameters<typeof setSetting.mutate>[0]["key"],
        value: target[key] ? "true" : "false",
      });
    });
  };

  return {
    state,
    toggle,
    setLevel,
    hostSubscriptions,
    anyRemoteEnabled,
    setHostSubscription,
    isMutating: setSetting.isPending,
    unavailable,
  };
}

/** 把信息流卡片种类映射到其订阅状态字段。Feed 组件据此过滤掉订阅关闭的卡片。 */
export function isCardKindSubscribed(
  kind: FeedCardKind,
  state: FeedSubscriptionState,
): boolean {
  switch (kind) {
    case "action-required":
      return state.actionRequired; // V1 恒为真（强制开启）
    case "approval":
      return state.approvals;
    case "shipped":
      return state.shipped;
    case "progress":
      return state.progress;
    case "observation":
      return state.auditLog;
  }
}
