// OPR.0.4.6.MH2 FR-2 —— UI 读路径上的 host 信封。
//
// 选中的 hostId 通过查询串（`?host=<id>`）挂在同一同源端点上；本机后台服务的
// 读穿透边界消费该信封，并把白名单内的 GET 转发给所选主机的后台服务
// （凭证始终留在服务端——浏览器永远不会拿到远程 base URL 或凭据）。
// 源响应形状原样透传，因此消费方 hook 保持既有类型；只有查询键多出 hostId。
//
// 零回归的「负向保证」就在这里：对本机主机（或未选择任何主机）而言，
// `withHostParam` 原样返回入参路径——按构造，本机这一侧不存在新的 fetch 路径（FR-2）。

/** UI 侧对后台服务 LOCAL_HOST_ID 的副本（fanout-contract.ts）。 */
export const LOCAL_HOST_ID = "local";

export function withHostParam(path: string, hostId: string | undefined): string {
  if (hostId === undefined || hostId === "" || hostId === LOCAL_HOST_ID) return path;
  return `${path}${path.includes("?") ? "&" : "?"}host=${encodeURIComponent(hostId)}`;
}
