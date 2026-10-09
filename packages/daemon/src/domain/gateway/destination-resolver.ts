// OPR.0.5.6.14——唯一的 destination 分类接缝。
//
// 每个 nudge/dispatch destination 都在此处且仅在此处分类一次：
//   pane-bound        → terminal transport（语义不变）
//   gateway-routable  → gateway 子系统负责投递（队列行为其输入，ledger 为投递记录；
//                       绝不查询 tmux，因为它无法承载这些地址）
//   unroutable        → 返回诚实的结构化说明性拒绝；对 tmux 永远无法承载的地址不查询 tmux
//
// D3 前向设计（Q-e）：未来 channel-map 层应扩展此函数
//（channel → thread 前的 rig|seat → seat），绝不能在其旁边形成第三个 resolver。
// 这里有意作为 wake 路径咨询的唯一分类点。
//
// 分类顺序如下：
//   1. `@external` 地址（已注册实体以及 literal-scheme 一次性地址）属于 gateway-routable，
//      使用折叠后的 gateway-owned wake 契约。注册/准入拒绝仍由既有 admission 层负责；
//      此处只判断“谁负责 transport”，不判断谁被准入。
//   2. 拥有显式 tmux binding 的拓扑席位属于 pane-bound，即 terminal transport；这包括拥有真实
//      pane 的已注册人工席位，也包括它停机时如实返回的 not-found 结果。仅仅因为席位存在于拓扑中，
//      paneless/external_cli binding 并不能成为 terminal evidence。
//   3. 其余可由 human registry 解析到已注册人员的地址（例如 canonical 形式别名
//      human-founder@kernel，即线上四行样本类别）属于 gateway-routable：这是无 pane 的虚拟身份，
//      与对应 `@external` 地址一样通过 gateway 投递。
//   4. 其他地址均为 unroutable，说明文案必须点名两项检查。
import { parseSessionName } from "../session-name.js";
import { resolveRegisteredHumanAddress, type HumanFragment } from "./human-registry.js";

export type DestinationClass =
  | { class: "pane-bound" }
  | { class: "gateway-routable"; resolvedHuman: string | null; via: "external-address" | "registry-alias" }
  | { class: "unroutable"; teaching: string };

export interface ClassifyDeps {
  /** 已注册人员实体。registry 缺失或不可读时为 null/空，此时分类降级为只检查
   *  external-address 与 topology。 */
  entities: readonly HumanFragment[] | null;
  /** 当前后台服务是否拥有此 destination 的显式 terminal transport？ */
  hasTerminalTransport: (destination: string) => boolean;
}

export function classifyDestination(destination: string, deps: ClassifyDeps): DestinationClass {
  const parsed = parseSessionName(destination);
  if (parsed.kind === "external") {
    const resolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
    return { class: "gateway-routable", resolvedHuman: resolved, via: "external-address" };
  }
  if (deps.hasTerminalTransport(destination)) {
    return { class: "pane-bound" };
  }
  const aliasResolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
  if (aliasResolved) {
    return { class: "gateway-routable", resolvedHuman: aliasResolved, via: "registry-alias" };
  }
  return {
    class: "unroutable",
    teaching:
      `unroutable: '${destination}' 在当前后台服务上没有 terminal transport，也未指向已注册人员——` +
      `没有 transport 能承载此地址（已检查：tmux binding + human registry）。` +
      `请修正地址，或使用 \`zrig gateway human add\` 注册人员。`,
  };
}
