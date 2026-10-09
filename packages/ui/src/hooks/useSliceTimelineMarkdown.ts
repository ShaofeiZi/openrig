// V0.3.1 slice 12 walk-item 1——向后兼容垫片。
//
// 过去 `useSliceTimelineMarkdown(absoluteSlicePath)` 获取 `<slicePath>/timeline.md`。
// Slice 12 将实现泛化为 `useScopeMarkdown(absoluteScopePath, filename)`，使任意工作范围
//（slice、任务目标、工作区）都能通过同一条感知白名单根目录的路径读取任意 Markdown 文件。
// 本文件现为轻量重导出垫片，使 slice-06 TimelineTab 调用点及其他引用
// `useSliceTimelineMarkdown` / `resolveSlicePathToAllowlist` 的代码无需修改即可继续工作。

import {
  useScopeMarkdown,
  resolveScopePathToAllowlist,
  type UseScopeMarkdownResult,
} from "./useScopeMarkdown.js";

export type UseSliceTimelineMarkdownResult = UseScopeMarkdownResult;

/** slice-06 / 阶段 6 调用点的向后兼容别名。新代码应直接调用 useScopeMarkdown，
 *  并显式传入文件名（"README.md"、"PROGRESS.md" 等）。 */
export function useSliceTimelineMarkdown(
  absoluteSlicePath: string | null,
): UseSliceTimelineMarkdownResult {
  return useScopeMarkdown(absoluteSlicePath, "timeline.md");
}

/** 解析器导出的向后兼容别名。 */
export const resolveSlicePathToAllowlist = resolveScopePathToAllowlist;
