// 工作组上下文 / 可组合上下文注入 v0（PL-014）——包组装器。
//
// 将 context_pack 包含的文件拼接为一段连贯、可直接粘贴的字符串。每个文件都有
// `## 文件：<path>（角色：<role>）` header，使目标 seat 能识别 bundle 结构。完整 bundle
// 以单行 manifest summary 开头，便于目标快速掌握 context。
//
// 一次连贯粘贴，而非 N 次独立发送——符合 PRD 第 5 项：“seat 以一次连贯的预加载注入接收 pack。”

import { readFileSync } from "node:fs";
import { ContextPackError, type ContextPackEntry } from "./context-pack-types.js";
import { estimateTokensFromBytes } from "./token-estimate.js";

export interface AssembledBundle {
  /** 已拼接、可供 SessionTransport.send 使用的 bundle string。 */
  text: string;
  /** 组合后字符串的总 byte 长度（UTF-8 编码）。 */
  bytes: number;
  /** daemon 派生的估算值（chars / 4 并取整）。 */
  estimatedTokens: number;
  /** 贯穿 assembly、供 dry-run preview 使用的逐文件 metadata。 */
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  /** manifest 中引用但磁盘上缺失的文件；在 preview 中呈现 warning 而非 hard fail，
   *  方便用户修复。 */
  missingFiles: Array<{ path: string; role: string }>;
}

export interface AssembleOpts {
  packEntry: ContextPackEntry;
  /** 默认为 readFileSync；测试时可注入。 */
  readFile?: (absPath: string) => string;
}

/** Atom 3 刻意保持简单的 composition separator。除此之外不修改 source byte：
 * 不 trim、不添加 framing header，也不强制最终换行。 */
export const PLAIN_COMPOSE_SEPARATOR = "\n\n";

export interface PlainFileInput {
  path: string;
  /** null 如实记录缺失 member。 */
  content: string | null;
}

export interface PlainFileAssembly {
  text: string;
  bytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string }>;
}

/**
 * Atom 3 compose core：按声明顺序拼接存在的文件内容。durable store 将每个 source 保留为
 * 独立 member；此 projection 是未来 delivery 操作可解析的精确内容，无需将 context 名词
 * 与 SessionTransport 耦合。
 */
export function assemblePlainFiles(opts: { files: PlainFileInput[] }): PlainFileAssembly {
  const present = opts.files.filter(
    (file): file is PlainFileInput & { content: string } => file.content !== null,
  );
  const text = present.map((file) => file.content).join(PLAIN_COMPOSE_SEPARATOR);
  const bytes = Buffer.byteLength(text, "utf-8");
  return {
    text,
    bytes,
    estimatedTokens: estimateTokensFromBytes(bytes),
    files: present.map((file) => {
      const fileBytes = Buffer.byteLength(file.content, "utf-8");
      return {
        path: file.path,
        bytes: fileBytes,
        estimatedTokens: estimateTokensFromBytes(fileBytes),
      };
    }),
    missingFiles: opts.files
      .filter((file) => file.content === null)
      .map((file) => ({ path: file.path })),
  };
}

const PACK_HEADER_PREFIX = "# zrig 上下文包：";
const FILE_HEADER_PREFIX = "## 文件：";

/**
 * 将 context pack 组合为一段可直接粘贴的字符串。
 *
 * Frame:
 *   # zrig 上下文包：<name> v<version>
 *   <purpose（如有）>
 *
 *   ## 文件：<path>（角色：<role>）
 *   <文件内容>
 *
 *   ## 文件：<path>（角色：<role>）
 *   <文件内容>
 *
 *   ...
 *
 * 每个文件以空行分隔，防止相邻内容意外合并为连续 markdown block。缺失文件会被跳过
 *（用户可在 `missingFiles` 中看到并修复）。
 */
export function assembleBundle(opts: AssembleOpts): AssembledBundle {
  const { packEntry } = opts;
  const reader = opts.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

  const sections: string[] = [];
  sections.push(`${PACK_HEADER_PREFIX}${packEntry.name} v${packEntry.version}`);
  if (packEntry.purpose) {
    sections.push(packEntry.purpose.trim());
  }

  const files: AssembledBundle["files"] = [];
  const missingFiles: AssembledBundle["missingFiles"] = [];

  for (const f of packEntry.files) {
    if (f.absolutePath === null) {
      missingFiles.push({ path: f.path, role: f.role });
      continue;
    }
    let content: string;
    try {
      content = reader(f.absolutePath);
    } catch (err) {
      throw new ContextPackError(
        "file_read_failed",
        `读取 pack 文件 ${f.absolutePath} 失败：${(err as Error).message}`,
        { packId: packEntry.id, path: f.path },
      );
    }
    const headerLine = f.summary
      ? `${FILE_HEADER_PREFIX}${f.path}（角色：${f.role}）——${f.summary}`
      : `${FILE_HEADER_PREFIX}${f.path}（角色：${f.role}）`;
    sections.push(headerLine);
    sections.push(content.trimEnd());
    const bytes = Buffer.byteLength(content, "utf-8");
    files.push({
      path: f.path,
      role: f.role,
      bytes,
      estimatedTokens: estimateTokensFromBytes(bytes),
    });
  }

  const text = sections.join("\n\n") + "\n";
  const bytes = Buffer.byteLength(text, "utf-8");
  return {
    text,
    bytes,
    estimatedTokens: estimateTokensFromBytes(bytes),
    files,
    missingFiles,
  };
}
