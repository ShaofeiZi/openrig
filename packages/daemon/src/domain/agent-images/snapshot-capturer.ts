// 分叉原语 + Starter 智能体镜像 v0（PL-016）——快照捕获器。
//
// 将 productive seat 的可恢复 state 捕获到新的 agent_image：runtime-specific resume token +
// manifest + 可选 cwd-delta。供 `zrig agent-image create <source-session> --name <name>` 与
// daemon HTTP 路由 /api/agent-images/snapshot 使用。
//
// Resume-token discovery 经 resume-token-discovery.ts 路由，使其与 /api/agent-images/fork
// 路由共享同一逻辑。
//
// failure mode 按 docs/as-built/architecture/adapters-and-runtimes.md § Resume honesty
// 呈现真实 error（不伪造 token，不自动回退到 fresh）。

import type Database from "better-sqlite3";
import type { SessionRegistry } from "../session-registry.js";
import type { RigRepository } from "../rig-repository.js";
import {
  AgentImageError,
  type AgentImageManifest,
} from "./agent-image-types.js";
import { AgentImageLibraryService } from "./agent-image-library-service.js";
import { discoverResumeToken } from "./resume-token-discovery.js";

export interface CaptureSnapshotOpts {
  sourceSession: string;
  name: string;
  version?: string;
  notes?: string;
  estimatedTokens?: number;
  lineage?: string[];
  files?: Map<string, string>;
}

export interface CaptureSnapshotResult {
  imageId: string;
  imagePath: string;
  manifest: AgentImageManifest;
}

export interface SnapshotCapturerDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  agentImageLibrary: AgentImageLibraryService;
  /** 目标安装根目录——通常为 ~/.openrig/agent-images/。 */
  targetRoot: string;
  /** 测试 seam——默认为 () => new Date()。 */
  now?: () => Date;
}

export class SnapshotCapturer {
  private readonly deps: SnapshotCapturerDeps;
  private readonly now: () => Date;

  constructor(deps: SnapshotCapturerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  capture(opts: CaptureSnapshotOpts): CaptureSnapshotResult {
    const { sourceSession, name } = opts;
    const version = opts.version ?? "1";

    const discovery = discoverResumeToken(this.deps.db, sourceSession);
    if (!discovery.ok) {
      throw new AgentImageError(
        discovery.failure.code === "session_not_found" ? "image_not_found" : "runtime_mismatch",
        discovery.failure.message,
        { sourceSession },
      );
    }
    const { runtime, nativeId, nodeCwd } = discovery.result;
    if (!nativeId) {
      throw new AgentImageError(
        "image_not_found",
        `无法为 ${runtime} source session '${sourceSession}' 找到 resume token。该 session 可能尚无 native conversation id——请在 seat 产生输出后重试，或使用 zrig context --refresh 重新采样。`,
        { sourceSession, runtime },
      );
    }

    const manifest: AgentImageManifest = {
      name,
      version,
      runtime,
      sourceSeat: sourceSession,
      sourceSessionId: nativeId,
      sourceResumeToken: nativeId,
      // PL-016 source-cwd 行为：捕获 source seat 的 resolved cwd，使“用作 starter”snippet
      // 可以发出 `cwd: <source_cwd>`。source node 没有已记录 cwd（legacy fixture 或
      // cwd-capture 前的 seat）时，nodeCwd 可为 null；此时省略 manifest field。
      ...(nodeCwd ? { sourceCwd: nodeCwd } : {}),
      createdAt: this.now().toISOString(),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      files: [],
      ...(opts.estimatedTokens !== undefined ? { estimatedTokens: opts.estimatedTokens } : {}),
      ...(opts.lineage !== undefined ? { lineage: [...opts.lineage] } : {}),
    };
    const fileContents = opts.files ?? new Map<string, string>();
    const imagePath = this.deps.agentImageLibrary.install(this.deps.targetRoot, manifest, fileContents);
    this.deps.agentImageLibrary.scan();
    return { imageId: `agent-image:${name}:${version}`, imagePath, manifest };
  }
}
