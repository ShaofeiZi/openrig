// Slice-11 slack-connector——一等 connector 配置（item 5 + T1075）。
//
// 配置是一等 JSON 文件，不只来自环境变量：包含 inbound destination、监听 channel、OWNER
// threshold、source label、必需 scope，以及 secret 指针。绝不保存 secret 值；它们位于 0600
// env 文件或环境变量中。未设置或不完整的配置会产生真实的 unconfigured 状态，不抛错也不静默，
// 让 `zrig slack status` 能准确告诉操作员还缺什么。
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";
import { OWNER_NOTIFICATION_LEVELS, type OwnerNotificationLevel } from "../../queue-transition-log.js";
import { BASELINE_REQUIRED_SCOPES } from "./capabilities.js";

export interface SlackConnectorConfig {
  enabled: boolean;
  /** Inbound：人类 Slack 消息落到这里；一等且可覆盖（T1075）。 */
  inboundDestination: string;
  /** 可选的 outbound 人类席位显式 allow-list；空表示任意 human-seat/human-gate。 */
  outboundDestinations: string[];
  /** 队列所在位置，显示在已发布消息 footer 中，绝不硬编码。 */
  sourceLabel: string;
  /** connector app 必须加入的 Slack channel；实时验证（item 5）。 */
  channel: string | null;
  /** connector 所需的 bot scope；对 GRANTED header 而非配置执行验证（item 5）。 */
  requiredScopes: string[];
  /** 保存 secret（webhook URL、bot/app token）的 0600 env 文件路径。 */
  secretsEnvFile: string | null;
  /**
   * S10：遗留字段——relay 的远端队列目标（connector 主机与队列主机不同时使用 OPENRIG_URL）。
   * 后台服务内子系统直接读取自身 QueueRepository，因此不再查询该字段；为保证旧配置文件无损
   * 加载而暂时保留，到下一个配置 schema 版本再移除。
   */
  queueUrl: string | null;
  minimumLevelThatPosts: OwnerNotificationLevel;
  minimumLevelThatInterrupts: OwnerNotificationLevel;
}

export const DEFAULT_CONFIG: SlackConnectorConfig = {
  enabled: false,
  inboundDestination: "operator-agent@kernel",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: null,
  requiredScopes: [...BASELINE_REQUIRED_SCOPES],
  secretsEnvFile: null,
  queueUrl: null,
  minimumLevelThatPosts: "NOTICE",
  minimumLevelThatInterrupts: "ALERT",
};

function validateLevel(field: string, value: unknown): asserts value is OwnerNotificationLevel {
  if (!OWNER_NOTIFICATION_LEVELS.includes(value as OwnerNotificationLevel)) {
    throw new Error(`${field} 必须是 ${OWNER_NOTIFICATION_LEVELS.join(", ")} 之一（收到 ${String(value)}）`);
  }
}

function validateConfig(cfg: SlackConnectorConfig): void {
  validateLevel("minimumLevelThatPosts", cfg.minimumLevelThatPosts);
  validateLevel("minimumLevelThatInterrupts", cfg.minimumLevelThatInterrupts);
}

export function configPathFor(home?: string): string {
  return path.join(home ?? getOpenRigHome(), "slack-connector.json");
}

export function loadConfig(home?: string): SlackConnectorConfig {
  const p = configPathFor(home);
  let raw: Partial<SlackConnectorConfig> & { alertTag?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConnectorConfig> & { alertTag?: unknown };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const { alertTag: _retiredAlertTag, ...supported } = raw;
  const cfg = { ...DEFAULT_CONFIG, ...supported };
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: SlackConnectorConfig, home?: string): string {
  validateConfig(cfg);
  const p = configPathFor(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return p;
}

export function configFileExists(home?: string): boolean {
  return fs.existsSync(configPathFor(home));
}

export interface ReadinessItem {
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * 真实的 unconfigured 状态（item 5）：根据配置与 secret 可解析性（而非具体值）生成静态、
 * 无网络 readiness checklist。实时 scope/membership 检查由 `zrig slack verify` 完成。
 * 本函数绝不抛错，只报告缺失项。
 *
 * S10：后台服务内子系统通过 Web API（`chat.postMessage`）发布 outbound 消息；现在由 bot token
 * 与 channel 共同充当 outbound gate，incoming webhook 已随 relay 退役。
 */
export function staticReadiness(cfg: SlackConnectorConfig, hasBotToken: boolean, hasAppToken: boolean): ReadinessItem[] {
  return [
    { ok: cfg.secretsEnvFile !== null || hasBotToken, label: "secrets-source", detail: cfg.secretsEnvFile ? `env 文件 ${cfg.secretsEnvFile}` : "仅使用环境变量" },
    { ok: hasBotToken, label: "bot-token", detail: hasBotToken ? "已解析" : "未设置（无法发布 outbound 消息，也无法验证 scope/membership）" },
    { ok: hasAppToken, label: "app-token (Socket Mode)", detail: hasAppToken ? "已解析" : "未设置（inbound 无法连接）" },
    { ok: cfg.channel !== null, label: "channel", detail: cfg.channel ?? "未设置（无法发布 outbound 消息）" },
    { ok: Boolean(cfg.inboundDestination), label: "inbound-destination", detail: cfg.inboundDestination },
    { ok: cfg.enabled, label: "enabled", detail: cfg.enabled ? "是" : "否（运行 `zrig slack enable`）" },
  ];
}
