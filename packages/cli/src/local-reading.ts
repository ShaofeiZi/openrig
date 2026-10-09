// 供 TUI 使用的只读子进程。不涉及后台服务、缓存、凭据或任何生命周期副作用。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config-store.js";
import { decodeAllowlist, resolveAllowedDirectory, resolveAllowedPath, readAllowedFile, FilePathSafetyError } from "@openrig/daemon/local-reading";

export interface LocalRequest { op: "roots" | "list" | "read"; root?: string; path?: string }

export function localRead(request: LocalRequest) {
  const config = new ConfigStore().resolve();
  const roots = decodeAllowlist(config.files.allowlist);
  if (request.op === "roots") {
    const targets = [
      ["项目意图", config.workspace.root ? path.join(config.workspace.root, "SPEC.md") : "", "file"],
      ["规格", config.workspace.specsRoot, "directory"],
      ["项目", config.workspace.projectsRoot, "directory"],
      ["任务目标与切片", config.workspace.slicesRoot, "directory"],
    ];
    return { source: "本地配置与磁盘", readAt: new Date().toISOString(),
      entries: targets.map(([label, source, kind]) => {
        let canonical = source!;
        try { canonical = fs.realpathSync(source!); } catch { /* 选中的读取会报告真实错误 */ }
        const root = [...roots].sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)
          .find((r) => canonical === r.canonicalPath || canonical.startsWith(r.canonicalPath + path.sep));
        return { label, kind, source, root: root?.name ?? "", path: root ? path.relative(root.canonicalPath, canonical) : "",
          ...(!source ? { error: "未配置数据源" } : !root ? { error: "数据源不在 files.allowlist 内，不允许本地读取" } : {}) };
      }),
    };
  }
  if (!request.root || typeof request.path !== "string") throw new Error("root 与 path 为必填项");
  if (request.op === "read") return readAllowedFile(roots, request.root, request.path);
  if (request.op !== "list") throw new Error("未知的本地读取操作");
  const directory = resolveAllowedDirectory(roots, request.root, request.path);
  // 一次只浏览一个选定目录；启动时绝不扫描整个工作区。
  return { source: directory, readAt: new Date().toISOString(),
    entries: fs.readdirSync(directory, { withFileTypes: true }).filter((e) => !e.name.startsWith("."))
      .map((entry) => {
        const relative = path.join(request.path!, entry.name);
        try {
          const resolved = resolveAllowedPath(roots, request.root!, relative);
          const stat = fs.statSync(resolved);
          return { label: entry.name, root: request.root!, path: relative, source: resolved, kind: stat.isDirectory() ? "directory" : "file" };
        } catch (error) {
          return { label: entry.name, root: request.root!, path: relative, source: path.join(directory, entry.name), kind: "file", error: error instanceof Error ? error.message : String(error) };
        }
      }).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.label.localeCompare(b.label)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(localRead(JSON.parse(process.argv[2] ?? "{}")))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof FilePathSafetyError ? error.code : "local_read_failed", message: error instanceof Error ? error.message : String(error) })); }
}
