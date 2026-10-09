// OPR.0.4.1.11.1（FR-2）——缓存种子接缝。按真实钩子使用的准确 queryKey
//（以 packages/ui/src/hooks 为依据）预填 react-query 缓存，使真实 App 能完全依靠虚拟数据
// 渲染，无需后台服务和 fetch。所有变更操作均不生效。
//
// Gate-0 范围：Dashboard 表面（rigs/summary + ps + spec-library）。同时预填逐工作组节点清单，
// 使拓扑表面无需新增接线即可工作。完整构建（Gate-0 之后）会把它扩展到完整 queryKey 枚举（D-4）。

import type { QueryClient } from "@tanstack/react-query";
import {
  rigSummary,
  psEntries,
  specLibrary,
  nodeInventoryByRig,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
} from "./fixtures.js";

// 预览表面轮询时使用的行数（node-details=100，其他为 50/80）。全部预填，使任意表面的首屏
// 都能立即呈现；其他 N 由 fetch stub 响应。
const PREVIEW_LINE_COUNTS = [50, 80, 100, 200];

export function seedTwinCache(qc: QueryClient): void {
  // Dashboard 与 AppShell 核心表面。
  qc.setQueryData(["rigs", "summary"], rigSummary);
  qc.setQueryData(["ps"], psEntries);
  qc.setQueryData(["spec-library", "all"], specLibrary);
  // 规范库筛选视图（资源库表面 + 节点详情的“智能体”透镜）。
  qc.setQueryData(["spec-library", "agent"], specLibrary.filter((s) => s.kind === "agent"));

  // 逐工作组拓扑表面，以工作组 id 为键。
  for (const rig of rigSummary) {
    qc.setQueryData(["rig", rig.id, "nodes"], nodeInventoryByRig[rig.id] ?? []);
    // 硬表面 1——拓扑图（xyflow 节点/边）。
    qc.setQueryData(["rig", rig.id, "graph"], rigGraphByRig[rig.id] ?? { nodes: [], edges: [] });
  }

  // 硬表面 2——实时节点详情，以 ["rig", rigId, "nodes", logicalId] 为键。
  for (const detail of Object.values(nodeDetailByKey)) {
    qc.setQueryData(["rig", detail.rigId, "nodes", detail.logicalId], detail);
  }

  // 内嵌实时终端预览（以会话为键），覆盖所有轮询行数进行预填。
  for (const preview of Object.values(sessionPreviewByName)) {
    for (const n of PREVIEW_LINE_COUNTS) {
      qc.setQueryData(["session-preview", preview.sessionName, n], { ...preview, lines: n });
    }
  }
}
