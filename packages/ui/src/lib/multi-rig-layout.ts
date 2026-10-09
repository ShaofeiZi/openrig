// V1 润色切片 Phase 5.2 P5.2-3 + P5.2-6 —— 多工作组画布辅助函数。
//
// 两个职责：
//   1. prefixRigData(rigId, nodes, edges)：跨工作组节点 ID 加前缀，
//      使合并后的画布满足 react-flow 的唯一 ID 要求。每个加前缀的节点携带
//      `data.rigId`，下游点击处理函数从 `node.data.rigId` 读取（而非闭包）。
//   2. packRigGroups(rigBounds, viewportWidth)：外层偏移排布。
//      单工作组内部布局已通过 applyTreeLayout 完成（或未展开时用固定折叠卡片尺寸）；
//      本辅助函数把每个工作组组放到宿主画布的网格偏移上。
//
// 布局策略 = 选项 (a)：单工作组内部布局 + 外层偏移（依 Phase 5.2 ACK §2）。
// 理由：折叠稳定性——切换工作组 N 不会重排 1..N-1，因为每个工作组内部布局独立、
// 且其外层偏移由网格槽位固定。

const PREFIX_DELIMITER = "::";

export const COLLAPSED_RIG_WIDTH = 280;
export const COLLAPSED_RIG_HEIGHT = 120;
const RIG_GUTTER_X = 48;
const RIG_GUTTER_Y = 48;
/** 工作组组在其展开子节点之上额外增加的高度
 *  （表头 + 计数条 + 内边距）。用于展开边界计算。 */
export const RIG_HEADER_HEIGHT = 60;
export const RIG_PADDING = 16;

/** 给每个节点 ID + 边端点加前缀 `${rigId}::`，使合并后的多工作组图
 *  拥有全局唯一 ID。把 `data.rigId` 穿到每个节点上，让点击处理函数无需闭包捕获即可读取。 */
export function prefixRigData<
  N extends { id: string; data?: Record<string, unknown> },
  E extends { id: string; source: string; target: string },
>(
  rigId: string,
  nodes: readonly N[],
  edges: readonly E[],
): { nodes: N[]; edges: E[] } {
  const prefixed = (id: string) => `${rigId}${PREFIX_DELIMITER}${id}`;
  return {
    nodes: nodes.map((n) => ({
      ...n,
      id: prefixed(n.id),
      // 某些节点形状携带用于 react-flow 父子关系的 parentId；若存在也加前缀。
      ...((n as unknown as { parentId?: string }).parentId
        ? { parentId: prefixed((n as unknown as { parentId: string }).parentId) }
        : {}),
      data: { ...(n.data ?? {}), rigId },
    })),
    edges: edges.map((e) => ({
      ...e,
      id: prefixed(e.id),
      source: prefixed(e.source),
      target: prefixed(e.target),
    })),
  };
}

/** 计算一组已布局节点（单工作组展开子节点）的包围盒，使外层工作组组尺寸正确。
 *  返回工作组内部相对坐标（左上角节点在原点）；外层偏移由 packRigGroups 添加。 */
export function computeBounds(
  nodes: ReadonlyArray<{ position: { x: number; y: number }; initialWidth?: number; initialHeight?: number }>,
): { width: number; height: number; minX: number; minY: number } {
  if (nodes.length === 0) {
    return { width: COLLAPSED_RIG_WIDTH, height: COLLAPSED_RIG_HEIGHT, minX: 0, minY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = n.initialWidth ?? 240;
    const h = n.initialHeight ?? 160;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return {
    width: Math.max(maxX - minX + 2 * RIG_PADDING, COLLAPSED_RIG_WIDTH),
    height: maxY - minY + 2 * RIG_PADDING + RIG_HEADER_HEIGHT,
    minX,
    minY,
  };
}

export interface RigBounds {
  rigId: string;
  width: number;
  height: number;
}

export interface PackedRig {
  rigId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** 在给定视口宽度下把工作组组打包进网格。每个工作组保留各自（可能不同的）边界；
 *  网格每行用一个最大宽度列追踪器，使较宽工作组不会挤压较窄的。
 *  简单贪心行填充——对 V1 集群规模足够。 */
export function packRigGroups(
  rigs: readonly RigBounds[],
  viewportWidth: number,
): PackedRig[] {
  const packed: PackedRig[] = [];
  const minViewport = Math.max(viewportWidth, COLLAPSED_RIG_WIDTH + 2 * RIG_GUTTER_X);
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxHeight = 0;
  for (const rig of rigs) {
    if (cursorX + rig.width > minViewport && cursorX > 0) {
      // 换行到下一行。
      cursorX = 0;
      cursorY += rowMaxHeight + RIG_GUTTER_Y;
      rowMaxHeight = 0;
    }
    packed.push({
      rigId: rig.rigId,
      offsetX: cursorX,
      offsetY: cursorY,
      width: rig.width,
      height: rig.height,
    });
    cursorX += rig.width + RIG_GUTTER_X;
    rowMaxHeight = Math.max(rowMaxHeight, rig.height);
  }
  return packed;
}
