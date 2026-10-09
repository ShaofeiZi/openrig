// V1 attempt-3 阶段 3 —— 按 code-map AFTER 树实现的 host 标签工具。
//
// 为 Dashboard 头部格式化 env / host 标签。V1 只有本机（localhost）；
// 多主机信封属于 V2 延后项。

export function formatHostLabel(): string {
  if (typeof window === "undefined") return "zrig @ localhost";
  return `zrig @ ${window.location.hostname || "localhost"}`;
}
