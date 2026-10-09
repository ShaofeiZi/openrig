// Fork Primitive + Starter Agent Images v0（PL-016）——manifest 解析器。
//
// 将 ~/.openrig/agent-images/<name>/manifest.yaml 解析为类型化 AgentImageManifest。
// 这是纯函数：解析器不访问文件系统，由调用方传入原始 YAML。校验包括必填字段、
// runtime 白名单，以及拒绝补充文件中的路径遍历。

import { parse as parseYaml } from "yaml";
import {
  AgentImageError,
  type AgentImageManifest,
  type AgentImageManifestFile,
  type AgentImageRuntime,
} from "./agent-image-types.js";

const ALLOWED_RUNTIMES: ReadonlySet<AgentImageRuntime> = new Set(["claude-code", "codex"]);
const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt", ".json"];

export function parseAgentImageManifest(rawYaml: string, sourcePath: string): AgentImageManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new AgentImageError(
      "manifest_parse_error",
      `${sourcePath} 中的 manifest 不是有效 YAML：${(err as Error).message}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中 manifest 的根节点必须是 YAML 对象`,
      { sourcePath },
    );
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中的 manifest 缺少必填字段 'name'`,
      { sourcePath },
    );
  }

  const versionRaw = obj["version"];
  if (versionRaw === undefined || versionRaw === null) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中的 manifest 缺少必填字段 'version'`,
      { sourcePath },
    );
  }
  const version = String(versionRaw);

  const runtime = obj["runtime"];
  if (typeof runtime !== "string" || !ALLOWED_RUNTIMES.has(runtime as AgentImageRuntime)) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中 manifest 的 runtime '${runtime}' 无效；允许值：${[...ALLOWED_RUNTIMES].join(", ")}`,
      { sourcePath, runtime },
    );
  }

  // 真实镜像必须包含源席位、会话 ID 和恢复 token。PRD 的 v0 manifest schema 将这些字段
  // 视为承重信息——没有恢复 token 的镜像无法被消费。
  const sourceSeatRaw = obj["source_seat"] ?? obj["sourceSeat"];
  if (typeof sourceSeatRaw !== "string" || sourceSeatRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中的 manifest 缺少必填字段 'source_seat'`,
      { sourcePath },
    );
  }
  const sourceSessionIdRaw = obj["source_session_id"] ?? obj["sourceSessionId"];
  if (typeof sourceSessionIdRaw !== "string" || sourceSessionIdRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中的 manifest 缺少必填字段 'source_session_id'`,
      { sourcePath },
    );
  }
  const sourceResumeTokenRaw = obj["source_resume_token"] ?? obj["sourceResumeToken"];
  if (typeof sourceResumeTokenRaw !== "string" || sourceResumeTokenRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `${sourcePath} 中的 manifest 缺少必填字段 'source_resume_token'`,
      { sourcePath },
    );
  }

  const createdAtRaw = obj["created_at"] ?? obj["createdAt"];
  const createdAt = typeof createdAtRaw === "string" && createdAtRaw.length > 0
    ? createdAtRaw
    : new Date(0).toISOString();

  const notes = typeof obj["notes"] === "string" ? (obj["notes"] as string) : undefined;

  // PL-016 source-cwd 行为：source_cwd 是创建快照时捕获的可选字段。此修复之前生成的
  // manifest 没有该字段；消费者会回退为“不显示 cwd 行”，以保持向后兼容。
  const sourceCwdRaw = obj["source_cwd"] ?? obj["sourceCwd"];
  const sourceCwd = typeof sourceCwdRaw === "string" && sourceCwdRaw.length > 0
    ? sourceCwdRaw
    : undefined;

  const filesRaw = obj["files"];
  const files: AgentImageManifestFile[] = [];
  if (Array.isArray(filesRaw)) {
    for (let i = 0; i < filesRaw.length; i++) {
      const f = filesRaw[i];
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        throw new AgentImageError(
          "manifest_invalid",
          `${sourcePath} 中 manifest 的 files[${i}] 条目格式错误（必须是包含 path 和 role 的对象）`,
          { sourcePath, index: i },
        );
      }
      const fr = f as Record<string, unknown>;
      const path = fr["path"];
      if (typeof path !== "string" || path.length === 0) {
        throw new AgentImageError(
          "manifest_invalid",
          `${sourcePath} 中 manifest 的 files[${i}] 缺少 'path'`,
          { sourcePath, index: i },
        );
      }
      if (path.includes("..") || path.startsWith("/")) {
        throw new AgentImageError(
          "manifest_invalid",
          `${sourcePath} 中 manifest 的 files[${i}].path '${path}' 必须是镜像内的相对路径（不能包含 '..'，也不能以 '/' 开头）`,
          { sourcePath, index: i, path },
        );
      }
      if (!ALLOWED_FILE_SUFFIXES.some((s) => path.endsWith(s))) {
        throw new AgentImageError(
          "manifest_invalid",
          `${sourcePath} 中 manifest 的 files[${i}].path '${path}' 使用了不支持的后缀；允许值：${ALLOWED_FILE_SUFFIXES.join(", ")}`,
          { sourcePath, index: i, path },
        );
      }
      const role = fr["role"];
      if (typeof role !== "string" || role.length === 0) {
        throw new AgentImageError(
          "manifest_invalid",
          `${sourcePath} 中 manifest 的 files[${i}] 缺少 'role'`,
          { sourcePath, index: i, path },
        );
      }
      const summary = typeof fr["summary"] === "string" ? (fr["summary"] as string) : undefined;
      files.push(summary === undefined ? { path, role } : { path, role, summary });
    }
  }

  const estimatedTokensRaw = obj["estimated_tokens"] ?? obj["estimatedTokens"];
  const estimatedTokens = typeof estimatedTokensRaw === "number" && Number.isFinite(estimatedTokensRaw)
    ? Math.max(0, Math.floor(estimatedTokensRaw))
    : undefined;

  const lineageRaw = obj["lineage"];
  const lineage = Array.isArray(lineageRaw)
    ? lineageRaw.filter((l): l is string => typeof l === "string" && l.length > 0)
    : undefined;

  return {
    name,
    version,
    runtime: runtime as AgentImageRuntime,
    sourceSeat: sourceSeatRaw,
    sourceSessionId: sourceSessionIdRaw,
    sourceResumeToken: sourceResumeTokenRaw,
    ...(sourceCwd !== undefined ? { sourceCwd } : {}),
    createdAt,
    ...(notes !== undefined ? { notes } : {}),
    files,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}
