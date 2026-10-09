// V0.3.1 slice 12 walk-item 1——任务目标 scope 数据层。
// V0.3.1 slice 13 walk-item 7——扩展 workflow_spec frontmatter
// + 投影的 topology spec 图。
//
// GET /api/missions/:missionId——返回聚合的任务目标元数据
// （missionPath + slices + 可选 workflow_spec 声明 + 可选投影 topology）。
// 支撑 Project 表面的 Mission Overview / Progress / Topology 标签页；
// 通过既有 /api/files/read 路由配合 useScopeMarkdown 读取 README / PROGRESS 内容。
//
// 返回：
//   200 {
//     missionId, missionPath, slices,
//     workflow_spec: { name, version } | null,
//     topology: { specGraph: SpecGraphPayload | null } | null
//   }
//   404 { error: "mission_not_found" } 无 slice 匹配时
//   503 { error: "slices_indexer_unavailable" } indexer 未接线时
//   503 { error: "slices_root_not_configured" } indexer 未就绪时
//
// workflow_spec 用 slice-indexer 同一个 parser 从 <missionPath>/README.md
// frontmatter 惰性解析。当 spec 在 WorkflowSpecCache 中时，
// topology.specGraph 通过 projectSpecGraph(spec, null) 投影；
// 已声明但未缓存时为 { specGraph: null }；未声明任何内容时为 null。

import { Hono } from "hono";
import { readMissionReadiness, readSliceReadiness } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SliceIndexer,
  SliceListEntry,
  WorkflowSpecRef,
} from "../domain/slices/slice-indexer.js";
import { parseWorkflowSpecRef } from "../domain/slices/slice-indexer.js";
import type { WorkflowSpecCache } from "../domain/workflow-spec-cache.js";
import { projectSpecGraph } from "../domain/workflow/slice-workflow-projection.js";
import { resolveNodeFile } from "../domain/scope/node-file.js";

export function missionsRoutes(): Hono {
  const app = new Hono();

  app.get("/:missionId", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json(
        {
          error: "slices_indexer_unavailable",
          hint: "任务目标数据层需要把 SliceIndexer 接入 AppDeps。",
        },
        503,
      );
    }
    if (!indexer.isReady()) {
      return c.json(
        {
          error: "slices_root_not_configured",
          hint: "运行 zrig config init-workspace，或把 workspace.slices_root 设为 workspace/missions。支持的形状：missions/<mission>/slices/<slice>。",
        },
        503,
      );
    }
    const missionId = c.req.param("missionId");
    const allSlices = indexer.list();
    const slices = allSlices.filter((s) => s.missionId === missionId);
    if (slices.length === 0) {
      return c.json({ error: "mission_not_found", missionId }, 404);
    }
    const missionPath = computeMissionPath(slices[0]!);
    const workflowSpec = readMissionWorkflowSpec(missionPath);
    const topology = computeMissionTopology(
      workflowSpec,
      c.get("workflowSpecCache" as never) as WorkflowSpecCache | undefined,
    );
    const readiness = readMissionReadiness(missionPath);
    const status = readiness.historicalStatus ?? readMissionStatus(missionPath);
    return c.json({
      missionId,
      missionPath,
      readiness,
      slices: slices.map(s => ({ ...s, readiness: readSliceReadiness(s.slicePath) })),
      workflow_spec: workflowSpec,
      topology,
      status,
    });
  });

  // Slice 18 §3.5——标记任务目标完成（Getting Started 完成并隐藏）。
  // 向任务目标 README.md frontmatter 写入 `status: complete`；UI storytelling
  // 预览据此门控，使已完成的任务目标从带状区消失。后台服务是审计轨迹表面；
  // UI 通过 localStorage 维护一个乐观本地镜像，使隐藏即时生效。
  app.post("/:missionId/complete", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json({ error: "slices_indexer_unavailable" }, 503);
    }
    const missionId = c.req.param("missionId");
    const allSlices = indexer.list();
    const slices = allSlices.filter((s) => s.missionId === missionId);
    if (slices.length === 0) {
      return c.json({ error: "mission_not_found", missionId }, 404);
    }
    const missionPath = computeMissionPath(slices[0]!);
    try {
      writeMissionStatusComplete(missionPath);
    } catch (err) {
      return c.json(
        {
          error: "mission_complete_write_failed",
          missionId,
          message: (err as Error).message,
        },
        500,
      );
    }
    // VM-005 B1（窄 C-vii 例外）：写入成功——丢弃 authored-status sidecar 缓存，
    // 使紧接着的下一次 /api/slices 读取即返回新值（读后写一致性）。
    // 未来任何后台服务 mission-status 变更路由都调用同一方法。
    indexer.invalidateMissionStatusCache();
    return c.json({ missionId, status: "complete" });
  });

  return app;
}

/** Slice 18 §3.5——向任务目标 README 的 frontmatter 写入 `status: complete`，
 *  frontmatter 块缺失时创建、已存在 status 字段时替换。幂等。
 * 保留无关的 frontmatter 字段。 */
function writeMissionStatusComplete(missionPath: string): void {
  // 修改任务目标实际拥有的节点文件；只有两者都没有的任务目标才新建一个，
  // 且新文件按当前名称 authored。
  const resolved = resolveNodeFile(missionPath);
  const readmePath = resolved ?? path.join(missionPath, "SPEC.md");
  let body = resolved ? fs.readFileSync(resolved, "utf-8") : "";
  const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fmInner = fmMatch[1] ?? "";
    const statusLineRegex = /^\s*status\s*:\s*[^\r\n]*$/m;
    let newFm: string;
    if (statusLineRegex.test(fmInner)) {
      newFm = fmInner.replace(statusLineRegex, "status: complete");
    } else {
      newFm = fmInner.trimEnd() + "\nstatus: complete";
    }
    body = body.replace(fmMatch[0], `---\n${newFm}\n---`);
  } else {
    body = `---\nstatus: complete\n---\n${body}`;
  }
  fs.writeFileSync(readmePath, body);
}

/** 从任意 slice 的 `slicePath` 推导任务目标目录的绝对路径。按工作区约定，
 *  slice 位于 `<missionsRoot>/<missionId>/slices/<sliceName>`，
 *  因此上溯两层即得到任务目标目录。 */
function computeMissionPath(slice: SliceListEntry): string {
  return path.resolve(slice.slicePath, "..", "..");
}

/** Slice 18 §3.5——从任务目标 README 的 frontmatter 解析 `status` 字段。
 *  存在时返回该字符串（不做枚举校验——v0 调用方主要关心 "complete" 值，
 *  但也可能出现其他 workflow 状态）；README 缺失 / 字段缺失时返回 null。
 *  支撑 Getting Started 完成并隐藏的持久 storytelling 过滤。 */
export function readMissionStatus(missionPath: string): string | null {
  const readmePath = resolveNodeFile(missionPath);
  if (!readmePath) return null;
  const raw = fs.readFileSync(readmePath, "utf-8");
  const fm = parseSimpleFrontmatter(raw);
  const value = fm["status"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** V0.3.1 slice 13 walk-item 7——从任务目标 README 的 frontmatter 解析
 *  `workflow_spec`。README 缺失或字段缺失/格式错误时返回 null。
 *  使用与 slice-indexer 相同的 parseWorkflowSpecRef 辅助函数，
 *  使两个表面保持同步。 */
function readMissionWorkflowSpec(missionPath: string): WorkflowSpecRef | null {
  const readmePath = resolveNodeFile(missionPath);
  if (!readmePath) return null;
  const raw = fs.readFileSync(readmePath, "utf-8");
  const fm = parseSimpleFrontmatter(raw);
  return parseWorkflowSpecRef(fm["workflow_spec"]);
}

/** 最小 frontmatter 解析器。slice-indexer 的 parseFrontmatter 是私有的；
 *  在此复制 v0 形状比暴露内部 API 更省，且让 missions 路由表面保持最小。 */
function parseSimpleFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** V0.3.1 slice 13 walk-item 7——当声明与缓存 spec 都存在时投影 spec 图。
 *  已声明但尚未缓存时返回带 `specGraph: null` 的 topology 信封；
 *  未声明任何内容时整个信封返回 `null`。 */
function computeMissionTopology(
  workflowSpec: WorkflowSpecRef | null,
  specCache: WorkflowSpecCache | undefined,
): { specGraph: ReturnType<typeof projectSpecGraph> | null } | null {
  if (!workflowSpec) return null;
  if (!specCache) return { specGraph: null };
  const row = specCache.getByNameVersion(workflowSpec.name, workflowSpec.version);
  if (!row) return { specGraph: null };
  // WorkflowSpecRow.spec 是投影器期望的 WorkflowSpec 对象。
  return { specGraph: projectSpecGraph(row.spec, null) };
}
