// 无后台服务的 fetch 接缝（补充 cache-seed；不是 MSW，不使用 service worker）。
// cache-seed（seed.ts）提供即时首屏，但多个钩子硬编码了 staleTime:0 + refetchInterval
//（useNodePreview/useSessionPreview、useSettings、useSpecLibrary、useContextFleet、useFiles），
// 即使已有种子仍会后台重新获取；没有后台服务时，请求会拒绝并呈现“获取失败”。此轻量 fetch
// 覆盖从同一套类型化 fixture 响应 /api/*，使强制重新获取的钩子取得 fixture 数据，并让 twin
// 保持 1:1 且不依赖后台服务。未映射的 /api/* 默认返回温和的 404 "unavailable"
//（钩子的优雅降级路径），绝不拒绝 fetch。

import {
  rigSummary,
  psEntries,
  specLibrary,
  serviceRigReview,
  nodeInventoryByRig,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
  sliceList,
  steeringPayload,
  missionBriefMd,
  artifactsTreeByPath,
} from "./fixtures.js";
// CORRECTIVE REDESIGN 2026-07-05——单一结构评审契约 fixture（以 useReview.ts 为类型基准）。
// 查找未命中时降级为温和的 404。
import {
  correctiveReviewBySlice,
  correctiveMissionReview,
  correctiveSlices,
  correctiveDetailByName,
  correctiveQitemById,
  correctiveMdByPath,
} from "./corrective/fixtures-corrective.js";

// 任务目标工作区根目录（匹配 /api/config workspace.root）；“引导”标签页的简报会相对于
// 包含任务目标路径的文件根目录读取 MISSION_BRIEF.md。
const TWIN_WORKSPACE_ROOT = "/Users/x/code/workspace";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch: typeof fetch | undefined = globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined;

function route(pathname: string, search: URLSearchParams): Response {
  if (pathname === "/api/rigs/summary") return json(rigSummary);
  if (pathname === "/api/ps") return json(psEntries);
  // 设置（useSettings，staleTime:0）。workspace.root 解锁 /project 表面
  //（useWorkspaceName）；预览设置让终端窗格保持一致。
  if (pathname === "/api/config") {
    return json({
      settings: {
        "workspace.root": { value: "/Users/x/code/workspace", source: "config", defaultValue: "" },
        "ui.preview.default_lines": { value: 100, source: "default", defaultValue: 100 },
        "ui.preview.refresh_interval_seconds": { value: 3, source: "default", defaultValue: 3 },
      },
    });
  }
  if (pathname === "/api/specs/library/spec_build_rig/review") return json(serviceRigReview);
  if (pathname === "/api/specs/library") return json(specLibrary);
  if (pathname.startsWith("/api/spec-library") || pathname.startsWith("/api/library")) return json(specLibrary);
  // 工作区 slices（/project 表面；任务目标由此派生）。修正演示 slices 合并进基础列表
  //（同一虚构系列）。
  if (pathname === "/api/slices") {
    return json({ ...sliceList, slices: [...sliceList.slices, ...correctiveSlices], totalCount: sliceList.slices.length + correctiveSlices.length });
  }

  // CORRECTIVE——组合后的单一结构评审契约（§3.1）。
  let cr = pathname.match(/^\/api\/review\/slice\/([^/]+)$/);
  if (cr) {
    const v = correctiveReviewBySlice[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  cr = pathname.match(/^\/api\/review\/mission\/([^/]+)$/);
  if (cr) {
    const v = correctiveMissionReview[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  if (pathname === "/api/review/agents") {
    const scope = search.get("scope") ?? "";
    const m07 = correctiveReviewBySlice["EX.2.0.0.07"];
    if (scope.startsWith("slice:")) {
      const v = correctiveReviewBySlice[scope.slice("slice:".length)];
      return v ? json(v.agents) : json({ error: "not_found" }, 404);
    }
    return m07 ? json({ ...m07.agents, scope }) : json({ error: "not_found" }, 404);
  }
  // Slice 页面前置数据（useSliceDetail）——未命中时由页面如实返回 404。
  cr = pathname.match(/^\/api\/slices\/([^/]+)$/);
  if (cr) {
    const v = correctiveDetailByName[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }
  // useQueueItemMap——feed 卡片可操作性与 NeedsYou 下钻。
  cr = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (cr) {
    const v = correctiveQitemById[decodeURIComponent(cr[1]!)];
    return v ? json(v) : json({ error: "not_found" }, 404);
  }

  // 任务目标“引导”标签页。
  // 面板 1：GET /api/steering → STEERING.md 投影 payload。
  if (pathname === "/api/steering") return json(steeringPayload);
  // useMission → 任务目标根路径（面板 2 相对于它读取 MISSION_BRIEF.md）。
  let mm = pathname.match(/^\/api\/missions\/([^/]+)$/);
  if (mm) {
    const missionId = decodeURIComponent(mm[1]!);
    return json({ missionId, missionPath: `${TWIN_WORKSPACE_ROOT}/missions/${missionId}`, slices: [] });
  }
  // useFilesRoots → 包含任务目标路径的根目录，使 useScopeMarkdown 能够解析。
  if (pathname === "/api/files/roots") {
    return json({ roots: [{ name: "workspace", path: TWIN_WORKSPACE_ROOT }] });
  }
  // useFilesList（产物导航器）：逐文件夹条目。
  if (pathname === "/api/files/list") {
    const p = search.get("path") ?? "";
    return json({ root: "workspace", path: p, entries: artifactsTreeByPath[p] ?? [] });
  }
  // useFilesRead → MISSION_BRIEF.md（面板 2）与修正证据 md（§7.2 右侧抽屉在 twin 中实时可用）；
  // 其他文件不可用。
  if (pathname === "/api/files/read") {
    const p = search.get("path") ?? "";
    if (p.endsWith("MISSION_BRIEF.md")) {
      return json({ content: missionBriefMd, mtime: "2026-06-23T08:30:00.000Z", contentHash: "twin-brief" });
    }
    const md = correctiveMdByPath[p];
    if (md) return json({ content: md, mtime: "2025-09-01T02:40:00.000Z", contentHash: `twin-${p}` });
    return json({ error: "not_found" }, 404);
  }

  // 内嵌终端预览（以会话为键）。
  let m = pathname.match(/^\/api\/sessions\/([^/]+)\/preview$/);
  if (m) {
    const name = decodeURIComponent(m[1]!);
    const lines = Number(search.get("lines") ?? 100);
    const fx = sessionPreviewByName[name];
    // 回显请求行数；无论 N 为何，内容都使用同一份虚拟数据。
    return fx ? json({ ...fx, lines }) : json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }
  // 种子表面不使用以节点为键的预览，因此优雅返回不可用。
  if (/^\/api\/rigs\/[^/]+\/nodes\/[^/]+\/preview$/.test(pathname)) {
    return json({ unavailable: true, reason: "preview_unavailable" }, 404);
  }

  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (m) {
    const detail = nodeDetailByKey[`${decodeURIComponent(m[1]!)}::${decodeURIComponent(m[2]!)}`];
    return detail ? json(detail) : json({ error: "not_found" }, 404);
  }
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/nodes$/);
  if (m) return json(nodeInventoryByRig[decodeURIComponent(m[1]!)] ?? []);
  m = pathname.match(/^\/api\/rigs\/([^/]+)\/graph$/);
  if (m) return json(rigGraphByRig[decodeURIComponent(m[1]!)] ?? { nodes: [], edges: [] });

  // 温和默认值：优雅返回 "unavailable"，绝不拒绝 fetch。
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  try {
    const u = new URL(url, "http://twin.local");
    if (u.pathname.startsWith("/api/")) return route(u.pathname, u.searchParams);
  } catch {
    /* 继续使用真实 fetch */
  }
  if (realFetch) return realFetch(input, init);
  return json({ unavailable: true, reason: "twin_offline" }, 404);
}) as typeof fetch;

export {};
