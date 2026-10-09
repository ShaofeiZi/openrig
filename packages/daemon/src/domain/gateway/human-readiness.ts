import type { HumanFragment } from "./human-registry.js";
import type { SlackConnectorConfig } from "./slack/config.js";
import { verifyScopes, verifyChannelMembership, type ScopeVerdict } from "./slack/slack-api.js";

export type HumanDeliveryReadinessState = "ready" | "not-ready" | "indeterminate";

export interface HumanDeliveryReadiness {
  state: HumanDeliveryReadinessState;
  configured: boolean;
  enabled: boolean;
  active: boolean;
  ready: boolean;
  connector: { kind: string; ref: string };
  reason: string;
  nextAction: string | null;
  checkedAt: string;
}

export interface HumanDeliveryReadinessInput {
  human: HumanFragment;
  config: SlackConnectorConfig;
  gatewayState: string;
  botToken: string | null;
}

export interface HumanDeliveryReadinessDeps {
  verifyScopes?: (token: string, required: string[]) => Promise<ScopeVerdict>;
  verifyMembership?: (token: string, channel: string) => Promise<{ ok: boolean; isMember: boolean; error?: string }>;
  now?: () => Date;
}

/** 将已注册 human 的 primary binding 解析为一条 delivery truth record。
 * connector detail 保持封装在这个 transport-neutral 形态后；secret 永不离开它。 */
export async function resolveHumanDeliveryReadiness(
  input: HumanDeliveryReadinessInput,
  deps: HumanDeliveryReadinessDeps = {},
): Promise<HumanDeliveryReadiness> {
  const primary = input.human.connectorBindings.find((binding) => binding.role === "primary")!;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = {
    connector: { kind: primary.kind, ref: primary.connectorRef },
    checkedAt,
  };
  const configured = primary.kind === "slack" && input.botToken !== null && input.config.channel !== null;
  const enabled = input.config.enabled;
  const active = enabled && input.gatewayState === "active";
  const result = (
    state: HumanDeliveryReadinessState,
    reason: string,
    nextAction: string | null,
  ): HumanDeliveryReadiness => ({ state, configured, enabled, active, ready: state === "ready", ...base, reason, nextAction });

  if (primary.kind !== "slack") return result("not-ready", `不支持 primary connector kind '${primary.kind}'`, "zrig gateway human show " + input.human.entityId + " --json");
  if (!input.botToken || !input.config.channel) return result("not-ready", "connector 配置不完整（缺少 bot token 或 channel）", "zrig slack status --json");
  if (!enabled) return result("not-ready", "connector 已配置但未启用", "zrig slack enable");
  if (input.gatewayState !== "active") return result("not-ready", `gateway 子系统状态为 ${input.gatewayState}`, "zrig daemon logs");
  if (input.config.outboundDestinations.length > 0 && !input.config.outboundDestinations.includes(input.human.address)) {
    return result("not-ready", `已注册地址 ${input.human.address} 被 connector policy 排除`, "zrig slack status --json");
  }

  try {
    const scope = await (deps.verifyScopes ?? ((token, required) => verifyScopes(token, required)))(
      input.botToken,
      [...new Set([...input.config.requiredScopes, "chat:write"])],
    );
    if (!scope.ok) {
      return scope.error
        ? result("indeterminate", `scope verification 不可用：${scope.error}`, "zrig slack verify --json")
        : result("not-ready", `connector 缺少必需 scope：${scope.missing.join(", ")}`, "zrig slack verify --json");
    }
    const membership = await (deps.verifyMembership ?? ((token, channel) => verifyChannelMembership(token, channel)))(input.botToken, input.config.channel);
    if (!membership.ok) return result("indeterminate", `channel membership verification 不可用：${membership.error ?? "未知错误"}`, "zrig slack verify --json");
    if (!membership.isMember) return result("not-ready", "connector 不是已配置 channel 的成员", "zrig slack verify --json");
    return result("ready", "已验证必需 scope 与 channel membership", null);
  } catch (error) {
    return result("indeterminate", `无法验证 connector readiness：${(error as Error).message}`, "zrig slack verify --json");
  }
}
