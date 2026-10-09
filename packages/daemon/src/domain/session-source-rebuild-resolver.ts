import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ResolvedStartupFile } from "./runtime-adapter.js";
import type { SessionSourceRebuildSpec } from "./types.js";

/**
 * 把 `session_source.mode: rebuild` artifact 集合解析成 `adapter.deliverStartup` 已接受的
 * `ResolvedStartupFile[]` 形状。解析时记录 gap（操作者声明但磁盘上不存在的路径）而不立即失败，
 * 因为其余已声明 artifact 仍可能携带足够上下文。只有全部声明路径都无法解析时，启动才失败。
 */
export interface RebuildArtifactsResult {
  ok: true;
  files: ResolvedStartupFile[];
  /** `ref.value` 中未解析到现有文件的路径。 */
  gaps: string[];
}

export type RebuildArtifactsOutcome =
  | RebuildArtifactsResult
  | { ok: false; error: string; gaps: string[] };

/**
 * 测试/宿主注入接缝：使单元测试无需访问真实文件系统即可断言路径解析。
 */
export type ExistsFn = (path: string) => boolean;

/**
 * 把操作者声明的 rebuild artifact 解析为 orchestrator 既有的 `ResolvedStartupFile[]` 形状，
 * 并保留操作者给出的信任优先级顺序。
 *
 * 身份诚实性说明：
 * - 本函数不执行、解析或评估 artifact 内容，只记录路径存在，并把 orchestrator 经标准
 *   `deliverStartup` 接缝投递字节所需的 metadata 交给它；该接缝对 `send_text` hint
 *   只会读取内容并通过 tmux 粘贴注入。
 * - artifact 标记为 `appliesOn: ["fresh_start"]`，因为从运行时视角看 rebuild 就是一次
 *   fresh launch；artifact 用操作者上下文为其播种，但运行时会话本身是新的。只有由 orchestrator
 *   设置的 `continuityOutcome: rebuilt` 能把它与普通 fresh launch 区分开。
 *
 * @param spec - 来自 member 的 rebuild spec；`ref.value` 是操作者按信任优先级声明的
 *               artifact 路径列表，最高信任项在前。
 * @param opts.exists - 文件系统存在性检查，默认使用 `existsSync`；测试传入 stub。
 */
export function resolveRebuildArtifacts(
  spec: SessionSourceRebuildSpec,
  opts: { exists?: ExistsFn } = {},
): RebuildArtifactsOutcome {
  const exists = opts.exists ?? existsSync;
  const gaps: string[] = [];
  const files: ResolvedStartupFile[] = [];
  for (const path of spec.ref.value) {
    if (!exists(path)) {
      gaps.push(path);
      continue;
    }
    files.push({
      path: basename(path),
      absolutePath: path,
      ownerRoot: dirname(path),
      // 使用 `send_text`，使 orchestrator 既有的启动后 TUI 投递路径在 harness 就绪后接收它们。
      // 操作者整理的上下文用于为运行中的会话播种，而不是落成文件系统投影的 guidance/skill 内容。
      deliveryHint: "send_text",
      required: true,
      // 使用 `fresh_start`，因为从运行时视角看 rebuild 就是 fresh launch；
      // 这些 artifact 是操作者声明的种子上下文。
      appliesOn: ["fresh_start"],
    });
  }
  if (files.length === 0) {
    return {
      ok: false,
      error: `rebuild：声明的 artifact 路径共 ${spec.ref.value.length}${spec.ref.value.length === 1 ? " 项" : " 项"}，均未解析到现有文件。请核对 session_source.ref.value 中的路径（按信任优先级声明，最高信任项在前）。`,
      gaps,
    };
  }
  return { ok: true, files, gaps };
}
