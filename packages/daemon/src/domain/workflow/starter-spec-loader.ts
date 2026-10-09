// 内置工作流规范加载器。
//
// 后台服务启动时遍历内置 starter 目录，把每个规范文件写入 PL-004 Phase D 的
// WorkflowSpecCache。操作幂等：重复启动时，或操作员已在工作区路径编写同名规范时，
// 加载器会跳过缓存中已有相同 (name, version) 的规范。Phase D 的工作区表面对账
// 契约要求下一次读取时操作员编辑优先，因此加载器不得覆盖它们。
//
// 为何存在时跳过，而不是始终 readThrough：
//   WorkflowSpecCache.readThrough(absPath) 会把缓存记录的 source_path 更新为调用方
//   传入的路径。若每次启动都对内置路径调用 readThrough，操作员在工作区路径编写的
//   记录会被改回内置路径，静默撤销覆盖。存在时跳过可保留该覆盖。
//
// 解决方式：希望从随包文件刷新内置记录的操作员（例如删除工作区覆盖后）可通过未来
// 的显式刷新路径直接调用 `cache.readThrough(builtinAbsPath)`。v0 不暴露该路径，
// 因为常见场景（后台服务冷启动且无覆盖）已由首次启动时的加载器处理。

import * as fs from "node:fs";
import * as path from "node:path";
import {
  WorkflowSpecError,
  parseWorkflowSpec,
  type WorkflowSpecCache,
} from "../workflow-spec-cache.js";

export interface StarterSpecLoadResult {
  /** 本次调用中新写入缓存的规范。 */
  loaded: Array<{ name: string; version: string; sourcePath: string }>;
  /** 已缓存的规范（操作员覆盖或先前启动写入）。 */
  skipped: Array<{ name: string; version: string; sourcePathInCache: string }>;
  /** 解析/加载失败的规范，供诊断日志呈现。 */
  errors: Array<{ sourcePath: string; code: string; message: string }>;
}

export interface StarterSpecLoaderOpts {
  /** Phase D 的 workflow-spec-cache（已在 startup.ts 中构造）。 */
  cache: WorkflowSpecCache;
  /** 包含内置 starter 规范文件的绝对目录（v0 仅支持 .yaml）。 */
  builtinDir: string;
}

const SPEC_FILE_EXTENSIONS = new Set([".yaml", ".yml"]);

/**
 * 遍历 builtinDir 并把每个规范文件写入缓存，跳过缓存中已有相同 (name, version)
 * 的规范。重复调用保持幂等。返回结构化结果供诊断日志使用（后台服务可按 INFO
 * 级别记录；测试对该结构作断言）。
 *
 * builtinDir 不存在时返回空结果而不报错；未随包提供 starter 规范也是有效配置。
 */
export function loadStarterWorkflowSpecs(opts: StarterSpecLoaderOpts): StarterSpecLoadResult {
  const result: StarterSpecLoadResult = { loaded: [], skipped: [], errors: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(opts.builtinDir, { withFileTypes: true });
  } catch {
    // 目录缺失表示未随包提供 starter 规范，这是有效配置而非错误。
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SPEC_FILE_EXTENSIONS.has(ext)) continue;

    const absPath = path.join(opts.builtinDir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      result.errors.push({
        sourcePath: absPath,
        code: "spec_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let parsedName: string;
    let parsedVersion: string;
    try {
      const parsed = parseWorkflowSpec(raw, absPath);
      parsedName = parsed.id;
      parsedVersion = parsed.version;
    } catch (err) {
      if (err instanceof WorkflowSpecError) {
        result.errors.push({ sourcePath: absPath, code: err.code, message: err.message });
      } else {
        result.errors.push({
          sourcePath: absPath,
          code: "spec_parse_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // 工作区表面对账：若该 (name, version) 已存在记录，则不要写入；操作员覆盖或
    // 先前启动写入的版本优先。
    const existing = opts.cache.getByNameVersion(parsedName, parsedVersion);
    if (existing) {
      result.skipped.push({
        name: parsedName,
        version: parsedVersion,
        sourcePathInCache: existing.sourcePath,
      });
      continue;
    }

    // 通过 readThrough 写入，使缓存的正常插入路径运行（计算哈希、生成 cached_at
    // 时间戳、对 roles 与 steps 做 JSON 序列化）。readThrough 会再次读取和解析文件；
    // 每次启动为每份规范付出的少量重复成本在 v0 中可以接受。
    try {
      const row = opts.cache.readThrough(absPath);
      result.loaded.push({ name: row.name, version: row.version, sourcePath: row.sourcePath });
    } catch (err) {
      if (err instanceof WorkflowSpecError) {
        result.errors.push({ sourcePath: absPath, code: err.code, message: err.message });
      } else {
        result.errors.push({
          sourcePath: absPath,
          code: "spec_seed_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/**
 * 相对于当前加载器文件在磁盘上的位置解析默认内置 starter 目录。开发环境
 * （从 `src/` 运行）和生产环境（从 `dist/` 运行）均适用；存在随包规范时，
 * 构建步骤会把工作流规范复制到 `dist/builtins/workflow-specs/`，因此解析路径
 * 可兼容两种布局。
 *
 * 布局：本文件位于 `<pkg>/{src|dist}/domain/workflow/`，内置目录位于
 * `<pkg>/{src|dist}/builtins/workflow-specs/`。从本文件目录向上两级即为包的
 * src/ 或 dist/ 根目录。
 */
export function defaultBuiltinSpecsDir(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // here = .../{src|dist}/domain/workflow
  // 包的 src/dist 根目录 = .../{src|dist}
  return path.resolve(here, "..", "..", "builtins", "workflow-specs");
}
