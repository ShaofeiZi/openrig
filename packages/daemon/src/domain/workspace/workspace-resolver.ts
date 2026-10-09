// PL-007 Workspace Primitive v0——为 whoami / node-inventory 消费方解析带类型的工作区上下文。
//
// 输入持久化的 RigSpec.workspace block、节点 cwd 和可选的逐会话环境覆盖，派生：
//   - workspaceRoot          ——逐字取自 spec
//   - activeRepo             ——优先环境覆盖，其次 default_repo，否则为 null
//   - repos                  ——带类型的列表（name、path、kind）
//   - knowledgeRoot、knowledgeKind——声明时逐字保留
//
// node-inventory 使用的逐节点 kind 解析会沿 cwd 目录树向上寻找包含它的最长 repo path；
// cwd 位于 knowledgeRoot 下时回退为 "knowledge"，否则为 null。

import * as path from "node:path";
import type { WorkspaceSpec, WorkspaceKind, NodeWorkspaceInfo } from "../types.js";

export interface WhoamiWorkspaceBlock {
  workspaceRoot: string;
  activeRepo: string | null;
  repos: Array<{ name: string; path: string; kind: WorkspaceKind }>;
  knowledgeRoot: string | null;
  knowledgeKind: WorkspaceKind | null;
}

export function resolveWorkspaceContext(opts: {
  spec: WorkspaceSpec | null;
  cwd: string | null;
  envOverride: string | null;
}): WhoamiWorkspaceBlock | null {
  const { spec, envOverride } = opts;
  if (!spec) return null;

  // 环境覆盖优先；没有覆盖时回退到 default_repo。按 PL-007 PRD 第 3 项，未知覆盖也逐字
  // 接受，因为操作员会有意识地设置 OPENRIG_TARGET_REPO。
  const repoNames = new Set(spec.repos.map((r) => r.name));
  let activeRepo: string | null = null;
  if (envOverride && envOverride.trim() !== "") {
    activeRepo = envOverride;
  } else if (spec.defaultRepo && repoNames.has(spec.defaultRepo)) {
    activeRepo = spec.defaultRepo;
  }

  return {
    workspaceRoot: spec.workspaceRoot,
    activeRepo,
    repos: spec.repos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
    knowledgeRoot: spec.knowledgeRoot ?? null,
    knowledgeKind: spec.knowledgeRoot ? "knowledge" : null,
  };
}

/** PL-007——根据节点 cwd 与工作组 WorkspaceSpec 派生逐节点工作区摘要，供 NodeInventory
 *  使用。工作组没有 workspace 声明时返回 null。 */
export function resolveNodeWorkspace(opts: {
  spec: WorkspaceSpec | null;
  cwd: string | null;
}): NodeWorkspaceInfo | null {
  const { spec, cwd } = opts;
  if (!spec) return null;

  let activeRepo: string | null = null;
  let kind: WorkspaceKind | null = null;
  if (cwd) {
    // 查找路径包含 cwd 且前缀最长的 repo。
    let best: { name: string; kind: WorkspaceKind; len: number } | null = null;
    for (const r of spec.repos) {
      if (isInside(cwd, r.path) && r.path.length > (best?.len ?? -1)) {
        best = { name: r.name, kind: r.kind, len: r.path.length };
      }
    }
    if (best) {
      activeRepo = best.name;
      kind = best.kind;
    } else if (spec.knowledgeRoot && isInside(cwd, spec.knowledgeRoot)) {
      kind = "knowledge";
    }
  }
  // cwd 无法解析时回退到工作组的 default_repo。
  if (!activeRepo && spec.defaultRepo) {
    activeRepo = spec.defaultRepo;
    if (!kind) {
      const r = spec.repos.find((x) => x.name === spec.defaultRepo);
      if (r) kind = r.kind;
    }
  }

  return {
    workspaceRoot: spec.workspaceRoot,
    activeRepo,
    kind,
  };
}

function isInside(child: string, parent: string): boolean {
  const normChild = path.resolve(child);
  const normParent = path.resolve(parent);
  if (normChild === normParent) return true;
  const rel = path.relative(normParent, normChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
