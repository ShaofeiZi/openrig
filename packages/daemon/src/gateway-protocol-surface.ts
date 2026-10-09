// M1 A5 —— gateway<->connector 线路编解码的窄公共表面，使 CLI 侧的 Slack CONNECTOR
// （监听 gateway 拨号的那个套接字）能对着唯一一份规范协议定义来解码/编码分帧消息。
// 轨道规则：exports map + dist + cli tsconfig paths 三者齐备（作为 daemon 子路径的 cli 消费方）。
// 仅转发再导出——此处无逻辑。
export * from "./domain/gateway/protocol.js";
