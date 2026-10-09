// UI 增强包 v0 —— 文件浏览器 + 写入 hooks。
//
// 封装：
//   - GET /api/files/roots → useFilesRoots
//   - GET /api/files/list?root=&path= → useFilesList
//   - GET /api/files/read?root=&path= → useFilesRead
//   - POST /api/files/write → useFilesWrite（mutation）
//
// 所有读取 hook 都把后台服务 503 / 4xx 以结构化错误（`unavailable` 形态）暴露，
// 以便在未配置白名单时界面能渲染出设置提示。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface FilesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export interface AllowlistRoot {
  name: string;
  path: string;
}

export interface FilesRootsResponse {
  roots: AllowlistRoot[];
  hint?: string;
}

async function fetchRoots(): Promise<FilesRootsResponse | FilesUnavailable> {
  const res = await fetch("/api/files/roots");
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as Partial<FilesUnavailable> & { error?: string; hint?: string };
    return { unavailable: true, error: body.error ?? "files_routes_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FilesRootsResponse;
}

export function useFilesRoots(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["files", "roots"],
    queryFn: fetchRoots,
    staleTime: 60_000,
    // OPR.0.4.6.MH2 FR-7/guard-B1 —— /api/files/* 仅限本地文件系统，刻意排除在
    // 远程透读之外；在选择了远程主机时，依赖文件的界面传 enabled:false，使请求根本不发出
    // （仅靠渲染门控仍会发起 fetch）。
    enabled: opts?.enabled ?? true,
  });
}

// --- list ---

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtime: string | null;
}

export interface FilesListResponse {
  root: string;
  path: string;
  entries: FileEntry[];
}

async function fetchList(root: string, path: string): Promise<FilesListResponse> {
  const res = await fetch(`/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as FilesListResponse;
}

export function useFilesList(root: string | null, path: string | null) {
  return useQuery({
    queryKey: ["files", "list", root, path],
    queryFn: () => fetchList(root!, path ?? ""),
    enabled: !!root,
    staleTime: 15_000,
    // V0.3.1 slice 17 walk-item 8（Explorer 自动展示）：窗口聚焦时重新拉取，
    // 使操作者切走标签页期间新建的文件/文件夹无需手动点刷新即可出现。
    //
    // 前向修复 #2：用 'always' 而非 `true`。staleTime 为 15_000 时，裸 `true` 会按
    // 新鲜度门控重新拉取——VM 验证里观察到在 15 秒窗口内短时间重新聚焦并不会重拉。
    // 'always' 则无视新鲜度在每次聚焦时都拉取。它是 Explorer 侧边栏的关键 hook
    // （经由 useMissionDiscovery + ProjectTreeView 驱动）。
    refetchOnWindowFocus: "always",
  });
}

// --- read ---

export interface FilesReadResponse {
  root: string;
  path: string;
  absolutePath: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  /** 操作者界面对齐 v0 第 5 项：后台服务截断返回内容时存在此值（文件超过 1 MB 上限）。 */
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

/**
 * R1（release-0.4.7）——带类型、可判别（discriminated）的读取失败。
 *
 * 后台服务已在 HTTP 状态码上区分了原因（`routes/files.ts`：`stat_failed → 404`，
 * `root_unknown`/路径错误 → 400，其余兜底 → 500）。R1 之前，`fetchRead` 把它们统统
 * 压成一个不透明的 `new Error("HTTP <status>")`，导致每个消费方只看到 `isError`，
 * 把可能是基础设施或配置失败的情况都渲染成“磁盘上文件不存在”的文案。
 * `FilesReadError` 把这一区分作为 `code` 携带，而不改动 `message` 文本——
 * 只渲染 `err.message` 的消费方（FileViewer、FilesWorkspace）零改动即可保持逐字节一致
 * （message 兼容锁定）。
 */
export class FilesReadError extends Error {
  readonly code: "absent" | "read_error" | "bad_path";
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`); // message 与 R1 之前的 `new Error("HTTP <status>")` 逐字节相同（架构锁定）
    // 刻意保持字节兼容（架构裁定 P2）：name 保持为 "Error"，使任何 `${err}` / err.name
    // 渲染与拆分前逐字节一致。不要在清理时把它“改好”成 "FilesReadError"——那会改变
    // 每一处 name 渲染点的输出。
    this.name = "Error";
    this.status = status;
    this.code = status === 404 ? "absent" : status === 400 ? "bad_path" : "read_error";
  }
}

async function fetchRead(root: string, path: string): Promise<FilesReadResponse> {
  const res = await fetch(`/api/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new FilesReadError(res.status);
  return (await res.json()) as FilesReadResponse;
}

export function useFilesRead(root: string | null, path: string | null) {
  return useQuery({
    queryKey: ["files", "read", root, path],
    queryFn: () => fetchRead(root!, path!),
    enabled: !!root && !!path,
    staleTime: 0, // 编辑模式下始终重读，以保证 mtime/contentHash 新鲜
  });
}

// --- 写入（第 4 项） ---

export interface FileWriteRequest {
  root: string;
  path: string;
  content: string;
  expectedMtime: string;
  expectedContentHash: string;
  actor: string;
}

export interface FileWriteSuccess {
  root: string;
  path: string;
  absolutePath: string;
  newMtime: string;
  newContentHash: string;
  byteCountDelta: number;
}

export interface FileWriteConflict {
  conflict: true;
  currentMtime: string;
  currentContentHash: string;
  message: string;
}

export type FileWriteResult = FileWriteSuccess | FileWriteConflict;

async function postWrite(req: FileWriteRequest): Promise<FileWriteResult> {
  const res = await fetch("/api/files/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { currentMtime: string; currentContentHash: string; message?: string };
    return {
      conflict: true,
      currentMtime: body.currentMtime,
      currentContentHash: body.currentContentHash,
      message: body.message ?? "文件已被外部修改",
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as FileWriteSuccess;
}

export function useFilesWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postWrite,
    onSuccess: (result, vars) => {
      // 仅在写入真正落地时才使缓存失效。遇到 409 冲突时必须保持读取查询稳定，
      // 让编辑器最后已知的 mtime/contentHash 与操作者的草稿存活足够久，以便冲突横幅渲染出来。
      // 若在此处失效，会重新拉取读取，编辑器的 useEffect 会基于新读取触发，草稿与冲突横幅
      // 都会被静默清掉——丢失操作者的编辑内容与冲突信号。
      if ("conflict" in result) return;
      qc.invalidateQueries({ queryKey: ["files", "read", vars.root, vars.path] });
      qc.invalidateQueries({ queryKey: ["files", "list", vars.root] });
    },
  });
}

export function fileAssetUrl(root: string, path: string): string {
  return `/api/files/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}
