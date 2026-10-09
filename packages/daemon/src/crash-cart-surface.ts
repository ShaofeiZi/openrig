// 窄化的 `@openrig/daemon/crash-cart` 公开 surface（打包裁定 A，护栏 1）：只公开 crash-cart
// 的 read/emit/detect，绝不整体导出后台服务（防止意外公开 API）。由 `rig crash-cart --json`
// 动词消费（调用时延迟导入，依赖护栏 2）。C2 读取（loadCrashCartDiscovery）原样 re-export
//（耦合护栏 2——单一实现，不设并行实现）。
export * from "./domain/crash-cart-discovery.js";
export * from "./domain/crash-cart-detect.js";
export * from "./domain/crash-cart-probes.js";
export * from "./domain/crash-cart-emit.js";
