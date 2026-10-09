// `@openrig/daemon/gateway-human-registry` 的窄公共表面（打包裁决 A，与 ./crash-cart 同一轨道）：
// human-fragment 模式 + registry 投影 + verb-add 写入器。registry 是 home 态（片段位于
// getOpenRigHome() 下），因此后台服务是它的规范归宿；CLI 的 `rig gateway human add` 动词在运行时
// 惰性 import 本表面（依赖轨道 2），而不是携带第二份副本——单一来源，无需双副本一致性钉。
export * from "./domain/gateway/human-registry.js";
export { runChannelOperation, channelStateDigest } from "./domain/gateway/channel-operations.js";
