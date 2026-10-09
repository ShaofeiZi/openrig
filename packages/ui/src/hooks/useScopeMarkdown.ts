// V0.3.1 slice 12 walk-item 1 —— 通用 scope-markdown 读取器。
//
// 通过既有 /api/files/read 后台服务路由读取 `<scopePath>/<filename>`，
// 使任何需要从项目 scope（slice、mission、workspace）渲染 markdown 文件的标签页
// 都能通过一个内置白名单根解析的 hook 完成。
//
// scopePath 是绝对文件系统路径（例如
// /Users/x/code/substrate/.../missions/release-0.3.1 或
// /Users/x/code/substrate/.../slices/06-…）。后台服务的
// /api/files/read 路由要求路径是相对某个已注册白名单根的路径，
// 并直接拒绝绝对路径。
//
// 本 hook 把 scope 的绝对路径对照 /api/files/roots（经 useFilesRoots 缓存 60 秒）
// 解析出哪个根包含该 scope，再用正确的相对路径发起读取。当无白名单根包含该 scope 时，
// hook 返回 `unavailable: true`——与 useMissionDiscovery / useSliceTimelineMarkdown 先例一致的优雅降级。
//
// 是 slice-06 时代 useSliceTimelineMarkdown 的泛化。useSliceTimelineMarkdown 作为薄包装保留导出，
// 使既有调用方（TimelineTab）无需修改即可继续工作。

import { useFilesRead, useFilesRoots, FilesReadError, type AllowlistRoot } from "./useFiles.js";

export type ScopeMarkdownState =
  | "idle"
  | "unresolved"
  | "absent"
  | "read_error"
  | "content";

export interface UseScopeMarkdownResult {
  /** 文件存在时为原始内容；否则为 null。 */
  content: string | null;
  isLoading: boolean;
  /** 文件不存在、无白名单根包含该 scope 或读取失败时为真。与初次加载期间的
   *  `content === null` 区分开。
   *
   *  R1（release-0.4.7）：现为派生的向后兼容字段
   * （`state !== "content" && !isLoading`）——每个在 `unavailable` 上分支的
   *  R1 前消费者看到字节一致的 true/false。请按 `state` 做诚实的三态区分。 */
  unavailable: boolean;
  /** 已知时为文件 mtime。 */
  mtime: string | null;
  /** 诊断：hook 为 /api/files/read 调用算出的 (root, relPath) 对。
   *  暴露出来供集成测试断言生产调用形状（绝对→相对转换）。 */
  resolved: { rootName: string; relPath: string } | null;
  /** R1（release-0.4.7）—— 判别式读取结果，使消费者不必把三种真相塌缩成一个
   *  `unavailable` 标志：`unresolved`（无白名单根包含 scope 路径——配置/根问题）|
   *  `absent`（文件确实缺失，404）| `read_error`（读取失败/基础设施，不是空文件）|
   *  `content`（读取成功）| `idle`。
   *
   *  P1 钉住（架构裁定）：`idle` 意味着*调用方门控、从未查看*
   *  （远端门控/未选 scope）——它不是关于文件的陈述。本 slice 的展示层把 `idle`
   *  渲染得像 `absent` 是**展示层决定，不是语义等价**；该区分必须在类型中保持可表达
   *  （ProofTab 远端跟进就是需要它的真实场景）。
   *
   *  `state` 仅在 `isLoading` 为 false 时有意义：fetch 进行中时尚未确定结果
   *  （它报告 `idle` 作为良性占位）——消费者在按 `state` 分支前必须先门控 `isLoading`。 */
  state: ScopeMarkdownState;
}

/** 当 `parent` 是 `child` 的路径前缀（二者视为绝对文件系统路径）时返回 true。
 *  段边界感知，故 `/work` 不是 `/workspace` 的前缀。 */
function isPathPrefix(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/\/+$/, "");
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/** 计算根下的路径：`<root>/<rel>` → `<rel>`。 */
function relativeUnder(rootPath: string, absChild: string): string {
  const p = rootPath.replace(/\/+$/, "");
  const c = absChild.replace(/\/+$/, "");
  if (c === p) return "";
  if (c.startsWith(p + "/")) return c.slice(p.length + 1);
  return c;
}

/** 选包含该绝对路径的最深匹配白名单根。无根包含时返回 null。
 *  导出供集成测试表面使用。 */
export function resolveScopePathToAllowlist(
  roots: AllowlistRoot[],
  absoluteScopePath: string,
): { rootName: string; relPath: string } | null {
  // 精确匹配优先；否则取最深前缀。
  const exact = roots.find((r) => r.path.replace(/\/+$/, "") === absoluteScopePath.replace(/\/+$/, ""));
  if (exact) return { rootName: exact.name, relPath: "" };
  const prefixed = roots
    .filter((r) => isPathPrefix(r.path, absoluteScopePath))
    .sort((a, b) => b.path.length - a.path.length);
  const winner = prefixed[0];
  if (!winner) return null;
  return { rootName: winner.name, relPath: relativeUnder(winner.path, absoluteScopePath) };
}

/** 通过带白名单根解析的 /api/files/read 获取 `<absoluteScopePath>/<filename>`。
 *  返回与 slice-06 useSliceTimelineMarkdown hook 相同的形状，使调用方能用单一心智模型在二者间切换。 */
export function useScopeMarkdown(
  absoluteScopePath: string | null,
  filename: string,
  opts?: { enabled?: boolean },
): UseScopeMarkdownResult {
  // OPR.0.4.6.MH2 guard-B1 —— /api/files/* 仅本地：null/禁用的 scope 路径必须发出
  // 零个文件请求（含 roots），而不只是渲染不可用。远端选中的表面传 null 路径和/或
  // enabled:false；下面的查询对它们从不触发。
  const enabled = (opts?.enabled ?? true) && absoluteScopePath !== null;
  const rootsQuery = useFilesRoots({ enabled });
  const rootsResp = rootsQuery.data;
  const rootsList: AllowlistRoot[] | null =
    rootsResp && "roots" in rootsResp ? rootsResp.roots : null;

  const resolved =
    absoluteScopePath && rootsList
      ? resolveScopePathToAllowlist(rootsList, absoluteScopePath)
      : null;

  const filePath = resolved
    ? resolved.relPath
      ? `${resolved.relPath}/${filename}`
      : filename
    : null;

  const readQuery = useFilesRead(
    resolved ? resolved.rootName : null,
    filePath,
  );

  // R1（release-0.4.7）：把读取结果归类为判别式 `state`；`unavailable` 由其派生
  // （`state !== "content" && !isLoading`），使每个 R1 前消费者在下方每处看到字节一致的
  // true/false。content / mtime / resolved 仍按各分支原样设置。
  let state: ScopeMarkdownState;
  let content: string | null = null;
  let mtime: string | null = null;
  let resolvedOut: { rootName: string; relPath: string } | null = null;
  let isLoading = false;

  if (!absoluteScopePath) {
    // 调用方门控——未选 scope / 远端选择（查询从未触发）
    state = "idle";
  } else if (rootsQuery.isError) {
    // G7：roots 获取失败是基础设施问题，不是配置错误——它绝不能伪装成
    // `unresolved`/配置文案（slice 上一级的核心原则）。此处 rootsList 为 null ⇒
    // R1 前会落到 `!resolved` 分支并渲染为配置/unresolved。
    state = "read_error";
  } else if (rootsQuery.isLoading) {
    state = "idle"; // 进行中；!isLoading 之前无意义
    isLoading = true;
  } else if (!resolved) {
    // roots 已加载，但无白名单根包含该 scope 路径（含 roots:[]）
    state = "unresolved";
  } else if (readQuery.isLoading) {
    state = "idle"; // 进行中
    isLoading = true;
    resolvedOut = resolved;
  } else if (readQuery.isError) {
    // 终于消费后台服务的状态信号（经 FilesReadError.code）：
    // 404 → absent，400/bad_path → 配置类，其他 → 基础设施。
    const err = readQuery.error;
    state =
      err instanceof FilesReadError
        ? err.code === "absent"
          ? "absent"
          : err.code === "bad_path"
            ? "unresolved"
            : "read_error"
        : "read_error";
    resolvedOut = resolved;
  } else if (!readQuery.data) {
    // 200 但无负载不等于缺失
    state = "read_error";
    resolvedOut = resolved;
  } else {
    state = "content";
    content = readQuery.data.content ?? null;
    mtime = readQuery.data.mtime ?? null;
    resolvedOut = resolved;
  }

  return {
    content,
    isLoading,
    unavailable: state !== "content" && !isLoading,
    mtime,
    resolved: resolvedOut,
    state,
  };
}
