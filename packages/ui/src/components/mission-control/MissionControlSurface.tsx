// V1 attempt-3 Phase 3 —— 按 for-you-feed.md 的 For You 信息流渲染形态，
// 在原地从 Phase 2 的壳+桩重构而来（DRIFT P2-C 解决）。组件名保留以向后兼容；
// 主体渲染 Feed（5 种卡片类型 + 透镜 chips + 客户端合成——按 SC-17 已交付，
// 按 SC-29 不新增后台服务事件类型）。

import { Feed } from "../for-you/Feed.js";

export function MissionControlSurface() {
  return <Feed />;
}
