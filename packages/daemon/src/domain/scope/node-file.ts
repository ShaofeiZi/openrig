import fs from "node:fs";
import path from "node:path";

/**
 * 工作节点上的作者契约文件，按优先级从高到低排列。
 *
 * `SPEC.md` 是当前名称；`README.md` 是旧名称并永久有效——休眠任务目标及所有历史校验回执
 * 都以 README 为依据，必须无需迁移或警告即可继续解析。节点同时携带二者并非错误：
 * SPEC.md 优先，审计只提示第二个文件而不会阻塞。
 *
 * 这是 CLI `lib/scope/scope-fs.ts` 列表的有意镜像，并非疏漏。后台服务不能导入
 * packages/cli——不存在 `@openrig/cli` 依赖，源码中已有三处声明——因此两套 scope 实现
 * 共享契约而不共享代码。修改任一处时必须同步另一处，否则产品会以两种方式读取自己的工作树。
 */
export const NODE_FILE_PRECEDENCE = ["SPEC.md", "README.md"] as const;

/** 当前任务目标说明文件名，其后是永久可读的旧文件名。 */
export const NOTES_FILE_PRECEDENCE = ["NOTES.md", "MISSION_NOTES.md"] as const;

export interface NotesFileResolution {
  path: string;
  name: (typeof NOTES_FILE_PRECEDENCE)[number];
}

/** 解析第一个可读的任务目标说明文件，优先使用当前名称。 */
export function resolveNotesFile(absPath: string): NotesFileResolution | null {
  for (const name of NOTES_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.R_OK);
      return { path: candidate, name };
    } catch {
      // 缺失、不可读或不是文件的候选项都继续尝试下一个名称。
    }
  }
  return null;
}

/**
 * 将当前节点文件名添加到既有优先级列表首位。
 *
 * 此处多个读取器已按各自表面选定的顺序搜索多个作者文件名，例如 slice 正文中
 * `IMPLEMENTATION-PRD.md` 排在 `README.md` 前。这些顺序是承重的局部决策，不能被压平成
 * 单一全局排序；只把 SPEC.md 放到最前，其余项目保持原顺序。
 */
export function withSpecFirst(candidates: readonly string[]): string[] {
  return ["SPEC.md", ...candidates.filter((c) => c !== "SPEC.md")];
}

/** 解析工作节点的作者契约文件；目录未声明节点时返回 null。 */
export function resolveNodeFile(absPath: string): string | null {
  for (const name of NODE_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 供通过注入读取器而非直接使用 `fs` 的调用方使用（例如以纯内存树测试的评审收集器）。
 * 返回读取器能够响应的第一个候选项及其路径；节点未声明作者文件时返回 null。
 */
export function resolveNodeFileVia(
  dir: string,
  read: (p: string) => string | null,
): { path: string; content: string } | null {
  for (const name of NODE_FILE_PRECEDENCE) {
    const candidate = path.join(dir, name);
    const content = read(candidate);
    if (content !== null && content !== undefined) return { path: candidate, content };
  }
  return null;
}

/** 文件名是任一作者节点文件（SPEC.md 或旧版 README.md）时返回 true。 */
export function isNodeFile(fileName: string): boolean {
  return (NODE_FILE_PRECEDENCE as readonly string[]).includes(fileName);
}
