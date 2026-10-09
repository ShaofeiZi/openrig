// M1 A6 v3——将 inbound registration gate 接入 daemon human-registry。保持为纯 factory
//（registry surface 由外部注入），以便无需 daemon 即可做单元测试；真实 daemon import 在 call site
// 保持懒加载（dep rail）。将 registry lookup 映射为 InboundRouter 的 InboundSenderResolution：
//   - registry 加载失败      -> 拒绝并 fail closed，呈现 reg.error（r1 A4b follow-on：registry
//                                损坏不同于 entity 缺失；不能因无法检查就虚构 human seat）。
//   - sender 已注册          -> 准入；source = 已注册 human 的 @external address。
//   - sender 未注册          -> 拒绝，并显示 resolver 的明确引导。

import type { InboundSenderResolution } from "./inbound.js";
// S10 re-home：此 module 现位于 daemon 内，因此 registry surface type 使用相对路径解析
//（lazy-import dep rail 是 CLI 层关注点；可注入 surface 仍保留给测试）。
import type { loadHumanRegistry as LoadFn, resolveSlackHandle as ResolveFn } from "../human-registry.js";

export interface RegistrySurface {
  loadHumanRegistry: typeof LoadFn;
  resolveSlackHandle: typeof ResolveFn;
}

export function makeInboundSenderResolver(reg: RegistrySurface, home?: string): (slackUserId: string) => InboundSenderResolution {
  return (slackUserId) => {
    const loaded = reg.loadHumanRegistry(home);
    if (!loaded.ok) {
      return { admitted: false, teaching: `human registry 不可用——已拒绝 inbound（fail-closed）：${loaded.error}` };
    }
    const r = reg.resolveSlackHandle(slackUserId, loaded.entities);
    return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
  };
}
