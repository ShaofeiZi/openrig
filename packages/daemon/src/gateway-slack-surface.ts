// S10 —— @openrig/daemon/gateway-slack 的窄表面：relay 切换把 slack 模块归位到后台服务后，
// CLI 存活的配置动词（`rig slack setup/status/verify`）恰好消费的内容。与 gateway-protocol /
// human-registry 同一依赖轨道模式：CLI 在调用时惰性 import 本表面；不导出其他任何东西。

export {
  loadConfig,
  saveConfig,
  configPathFor,
  staticReadiness,
  DEFAULT_CONFIG,
  type SlackConnectorConfig,
  type ReadinessItem,
} from "./domain/gateway/slack/config.js";
export { resolveSecret, checkEnvFilePermissions } from "./domain/gateway/slack/secrets.js";
export {
  buildSlackAppManifest,
  CANONICAL_MANIFEST_SOURCES,
  type SlackAppManifest,
  type SlackManifestBundle,
} from "./domain/gateway/slack/manifest.js";
export { FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES } from "./domain/gateway/slack/capabilities.js";
export { runChannelOperation, channelStateDigest, type ChannelActor } from "./domain/gateway/channel-operations.js";
export {
  verifyScopes,
  verifyChannelMembership,
  type FetchImpl,
  type ScopeVerdict,
} from "./domain/gateway/slack/slack-api.js";
