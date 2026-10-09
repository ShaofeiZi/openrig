// OPR.0.5.5.20——后台服务绑定来源：纯绑定计划解析器。绑定意图只能通过专用的
// OPENRIG_BIND_HOST 表面到达后台服务；复用的路由环境变量
//（OPENRIG_HOST/RIGGED_HOST——任何受管环境都可能注入的客户端端点）绝不能选择
// 单地址绑定分支。旧混用方式已有实际代价：父后台服务继承了在受管环境中运行维护命令时
// 设置的 OPENRIG_HOST=127.0.0.1，并静默丢失 Tailscale 监听器
//（操作员接力 qitem-20260827070400）。本实现将 auth-bearer-tailscale-trust 关于
// “显式选择 vs 默认值”的裁定重新落实到受管环境绝不注入的通道上，而不是推翻该裁定。

export interface BindPlanInput {
  /** 专用于绑定意图的环境变量 OPENRIG_BIND_HOST；只有空白时视为缺失。 */
  bindHostEnv: string | undefined;
  /** 复用的路由环境变量 OPENRIG_HOST/RIGGED_HOST；只为如实记录来源而观察，
   *  绝不参与绑定策略。 */
  routingHostEnv: string | undefined;
  /** 存在时为活动的 Tailscale 接口 IP。 */
  tailscaleIp: string | null;
}

export interface BindPlan {
  mode: "explicit" | "default";
  hosts: string[];
  tailscaleDetected: boolean;
  /** 路由环境变量存在但被绑定策略忽略时设置；后台服务会记录该来源，避免静默忽略。 */
  ignoredRoutingHost?: string;
}

export function resolveBindPlan(input: BindPlanInput): BindPlan {
  const bindHost = input.bindHostEnv?.trim() || undefined;
  const routingHost = input.routingHostEnv?.trim() || undefined;
  const tailscaleDetected = input.tailscaleIp !== null;
  if (bindHost) {
    return { mode: "explicit", hosts: [bindHost], tailscaleDetected };
  }
  const hosts = input.tailscaleIp ? ["127.0.0.1", input.tailscaleIp] : ["127.0.0.1"];
  return {
    mode: "default",
    hosts,
    tailscaleDetected,
    ...(routingHost ? { ignoredRoutingHost: routingHost } : {}),
  };
}
