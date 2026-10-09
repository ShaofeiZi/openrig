// OPR.0.6.0.5——OpenRig 随附的 Slack app manifest，用户可据此创建自己的私有
// Socket Mode app。`zrig slack manifest` 与后台服务只读路由共享一个无 I/O 的纯构造器，
// 因而 CLI 与 TUI 渲染相同对象。
//
// scope 和 event 从连接器权威源派生，绝不在此重复列举：
//   机器人权限范围 = BASELINE_REQUIRED_SCOPES + FEATURE_SCOPES（capabilities.ts）
//   bot events = 通过 EVENT_SUBSCRIPTIONS 得到 ADMITTED_EVENT_TYPES（capabilities.ts）。
// Slack subscription 名不总等于 payload type（订阅 `message.channels` 会收到 type 为
// `message` 的 payload），所以映射是显式且受检查的。构造器不导入配置，
// 因而无法加载文件或读取环境。
import { stringify } from "yaml";
import { ADMITTED_EVENT_TYPES, BASELINE_REQUIRED_SCOPES, EVENT_SUBSCRIPTIONS, FEATURE_SCOPES } from "./capabilities.js";

export const MANIFEST_DISPLAY_NAME = "zrig";
export const SLACK_CREATE_APP_URL = "https://api.slack.com/apps?new_app=1&manifest_yaml=";

export interface SlackAppManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface SlackManifestBundle {
  manifest: SlackAppManifest;
  /** YAML 形式的 manifest，与预填链接携带的内容完全一致。 */
  yaml: string;
  /** Slack 的“从 manifest 创建 app”链接，其中 YAML 已做 URL 编码。 */
  url: string;
  scopes: string[];
  events: string[];
}

export interface ManifestSources {
  requiredScopes: readonly string[];
  featureScopes: readonly string[];
  admittedEventTypes: readonly string[];
  eventSubscriptions: Readonly<Record<string, { subscription: string; scope: string }>>;
}

export const CANONICAL_MANIFEST_SOURCES: ManifestSources = {
  requiredScopes: BASELINE_REQUIRED_SCOPES,
  featureScopes: FEATURE_SCOPES.map((f) => f.scope),
  admittedEventTypes: ADMITTED_EVENT_TYPES,
  eventSubscriptions: EVENT_SUBSCRIPTIONS,
};

/** 从权威源构建 manifest。若允许的 event type 没有 subscription 映射，或订阅事件所需
 *  scope 未申请，则抛错——会被 Slack 拒绝或静默丢失入站流量的 manifest 属于构造错误，
 *  不应成为运行时意外。 */
export function buildSlackAppManifest(sources: ManifestSources = CANONICAL_MANIFEST_SOURCES): SlackManifestBundle {
  const scopes = [...new Set([...sources.requiredScopes, ...sources.featureScopes])].sort();
  const events: string[] = [];
  for (const type of sources.admittedEventTypes) {
    const mapped = sources.eventSubscriptions[type];
    if (!mapped) throw new Error(`Slack manifest：允许的 event type "${type}" 没有 subscription 映射`);
    if (!scopes.includes(mapped.scope)) {
      throw new Error(`Slack manifest：event "${mapped.subscription}" 需要尚未申请的 scope "${mapped.scope}"`);
    }
    events.push(mapped.subscription);
  }
  events.sort();
  const manifest: SlackAppManifest = {
    display_information: {
      name: MANIFEST_DISPLAY_NAME,
      description: "通过 Socket Mode 将 zrig 实例连接到 Slack。",
    },
    features: { bot_user: { display_name: MANIFEST_DISPLAY_NAME, always_online: false } },
    oauth_config: { scopes: { bot: scopes } },
    settings: {
      event_subscriptions: { bot_events: events },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
  const yaml = stringify(manifest);
  return { manifest, yaml, url: SLACK_CREATE_APP_URL + encodeURIComponent(yaml), scopes, events };
}
