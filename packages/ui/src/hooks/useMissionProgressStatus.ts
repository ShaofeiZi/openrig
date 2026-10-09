// V1 attempt-3 Phase 5 P5-6 —— MissionStatusBadge 实时拉取 PROGRESS.md。
//
// 通过既有的 /api/files/read 后台服务路由拉取 `<missionPath>/PROGRESS.md`
// （按 SC-29 不新增后台服务端点），并用 parseMissionStatus() 解析 frontmatter 的
// `status:` 字段。依据 project-tree.md L132–L133：“status 取自 PROGRESS.md frontmatter
// 或顶层 status: 字段。……驱动方用一个轻量解析器实现，每个任务节点加载时读一次
// PROGRESS.md（而非每次渲染都读）；文件 mtime 变化时使缓存失效。”
//
// TanStack Query 提供缓存层；staleTime 加上 /api/files/read 响应里的 `mtime` 字段，
// 共同实现感知 mtime 的缓存：查询在失效时重新拉取，后台服务的 mtime 元数据让界面
// 可在需要时展示“新鲜 vs 陈旧”指示。

import { useFilesRead, FilesReadError } from "./useFiles.js";
import { parseMissionStatus, type MissionStatus } from "../components/MissionStatusBadge.js";

export interface UseMissionProgressStatusResult {
  status: MissionStatus | "unknown";
  isLoading: boolean;
  /** 为 true 表示该任务没有 PROGRESS.md（或读取失败）；status 为 "unknown"，
   *  界面可据此给出提示。 */
  unavailable: boolean;
  /** PROGRESS.md 的 mtime（已知时），否则为 null。可用于新鲜度指示或失效 hook。 */
  mtime: string | null;
  /** R1（release-0.4.7）——status 为何未知，让消费方不再把“文件确实不存在”与
   *  “基础设施读取失败”混为一谈：`absent`（404）| `read_error`（5xx / 无负载的 200——
   *  不是空文件）| null（非读取失败：被门控、加载中，或读取成功）。
   *  目前唯一消费方（ProjectTreeView 的安静角标）并不据此分支——它是后续切片用来
   *  “让树不再说谎”的判别依据，无需再给本 hook 重新接管线。 */
  reason: "absent" | "read_error" | null;
}

export function useMissionProgressStatus(
  root: string | null,
  missionPath: string | null,
): UseMissionProgressStatusResult {
  const progressPath =
    root && missionPath ? `${missionPath}/PROGRESS.md` : null;
  const readQuery = useFilesRead(root, progressPath);

  if (!root || !missionPath) {
    // 调用方已门控（无 root / 无任务路径）——不是读取失败
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null, reason: null };
  }

  if (readQuery.isLoading) {
    return { status: "unknown", isLoading: true, unavailable: false, mtime: null, reason: null };
  }

  if (readQuery.isError || !readQuery.data) {
    // R1：区分“文件确实不存在”（404）与读取失败。5xx/其他读取错误——或无负载的 200——
    // 属于基础设施问题，而非文件为空/不存在；只有 404 才表示“文件不在那里”。
    // 两种情况下 `unavailable` 都保持 true（status 仍是 "unknown"）；`reason` 说明原因。
    const err = readQuery.error;
    const reason: "absent" | "read_error" =
      readQuery.isError && err instanceof FilesReadError && err.code === "absent"
        ? "absent"
        : "read_error";
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null, reason };
  }

  return {
    status: parseMissionStatus(readQuery.data.content),
    isLoading: false,
    unavailable: false,
    mtime: readQuery.data.mtime ?? null,
    reason: null,
  };
}
