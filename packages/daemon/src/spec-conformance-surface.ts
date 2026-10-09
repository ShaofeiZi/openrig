// Build B——spec 与实时拓扑一致性的窄公开 surface，使 CLI 侧 `rig doctor` 与后台服务侧
// bundle-export 路径返回相同 delta。两个 surface 对 rig 大小得出不同结果，是此处报告问题的
// 上一层缺陷。线路规则：exports map + dist + CLI tsconfig paths，三者缺一不可。仅 re-export，
// 此处无逻辑。
export * from "./domain/spec-live-conformance.js";
