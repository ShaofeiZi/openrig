// Spec Library + Activation Lens v0 中的工作流——workflow scanner。
//
// SpecLibraryService 已能分类 rig + agent YAML 文件。本 scanner 直接读取 workflow_specs
// SQLite cache（PL-004 Phase D），并重新解析每个缓存 row，提取 review payload topology graph
// 所需的逐 step 路由，从而把 workflow_specs 增加为第三种 library kind。
//
// cache 是后台服务已见 workflow_specs 的唯一真源，其中既包括 startup 时由
// loadStarterWorkflowSpecs 填种的 built-in starter，也包括 workspace-surface reconciliation
// 契约从工作区路径读取的 operator-authored spec。读取 cache 而不是重新遍历目录意味着：不新增
// env 配置、不复制 parse 逻辑，并让 scanner 与 `zrig workflow specs` 保持一致（相同 row、
// 相同真源）。
//
// Built-in 检测：当且仅当 row 的 `source_path` 位于后台服务 workflowBuiltinSpecsDir 下时，
// 才视为 built-in；使用与 /api/workflow/specs 相同的 `path.sep` 边界检查。

import * as path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkflowSpec, WorkflowExitKind, WorkflowAgentHarness, WorkflowGateSpec } from "./workflow-types.js";
import type { WorkflowSpecCache } from "./workflow-spec-cache.js";
import type { EventBus } from "./event-bus.js";

export interface SpecLibraryWorkflowEntry {
  id: string;
  kind: "workflow";
  name: string;
  version: string;
  /** source_path 位于 workflowBuiltinSpecsDir 下时为 "builtin"，否则为 "user_file"。 */
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
  /** 当且仅当 sourcePath 位于后台服务随附 built-in 目录下时为 true。 */
  isBuiltIn: boolean;
  /** 在 row summary 行呈现的低开销计数。 */
  rolesCount: number;
  stepsCount: number;
  terminalTurnRule: string;
  targetRig: string | null;
  /**
   * Slice 11（workflow-spec-folder-discovery）——诊断状态。"valid" row 已解析 payload，
   * 可以操作；"error" row 来自 workflows 文件夹扫描发现的 malformed YAML。Library UI
   * 用错误样式渲染，并显示 errorMessage，让操作员可原地修复文件。
   */
  status: "valid" | "error";
  /** 仅在 status === "error" 时填充，包含具体 parse/validate 诊断。 */
  errorMessage: string | null;
}

export interface SpecLibraryWorkflowReview {
  kind: "workflow";
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  terminalTurnRule: string;
  rolesCount: number;
  stepsCount: number;
  isBuiltIn: boolean;
  sourcePath: string;
  cachedAt: string;
  /** Topology graph projection：node 来自 `roles`，edge 由每个 step 的
   *  next_hop.suggested_roles → 下一 step id 派生。结构与 Slice Story View v1 的 Topology
   *  tab 相同，consumer 复用同一组 UI primitive 渲染。
   *
   *  OPR.0.4.6.WF4 Q1（架构裁定）：projection 从 `next_hop.on` 增加 branch edge
   *  （routingType 'branch' + 触发 exit），修正 false-terminal 缺陷（带 on-target 的 step 不是
   *  terminal），并投影可选 harness/host/gate node 字段。所有新增都通过省略保持字节身份：
   *  只有 suggested_roles、没有 on/harness/host/gate 的 spec 与之前投影完全相同，不含
   *  'branch' edge、branchOn key 或可选 node key。 */
  topology: {
    nodes: Array<{
      stepId: string;
      role: string;
      objective: string | null;
      preferredTarget: string | null;
      isEntry: boolean;
      isTerminal: boolean;
      /** OPR.0.4.6.WF4 Q1-P1——step 未声明时省略。 */
      harness?: WorkflowAgentHarness;
      host?: string;
      gate?: WorkflowGateSpec;
    }>;
    edges: Array<{
      fromStepId: string;
      toStepId: string;
      /** OPR.0.4.6.WF4 Q1-P2——'direct' 的封闭词表扩展。 */
      routingType: "direct" | "branch";
      /** 触发 exit；只存在于 'branch' edge。 */
      branchOn?: WorkflowExitKind;
    }>;
  };
  /** 渲染在 graph 下方的逐 step 列表。 */
  steps: Array<{
    stepId: string;
    role: string;
    objective: string | null;
    allowedExits: string[];
    /** 从 next_hop.suggested_roles → step id 解析出的 destination。 */
    allowedNextSteps: Array<{ stepId: string; role: string }>;
  }>;
}

export interface ScanWorkflowSpecsOpts {
  db: Database.Database;
  /** 后台服务随附 builtin starter 目录的绝对路径；null/undefined 表示不检测 isBuiltIn，
   *  所有 row 都渲染为 user_file。 */
  workflowBuiltinSpecsDir: string | null;
}

interface SpecRow {
  spec_id: string;
  name: string;
  version: string;
  purpose: string | null;
  target_rig: string | null;
  roles_json: string;
  steps_json: string;
  coordination_terminal_turn_rule: string;
  source_path: string;
  source_hash: string;
  cached_at: string;
  // Slice 11——migration 040 增加的诊断列。测试 harness 只应用 033 schema 时可能缺失；为保持
  // 向后兼容，把缺失视为 status='valid'、error_message=null。
  status?: string;
  error_message?: string | null;
}

export function scanWorkflowSpecs(opts: ScanWorkflowSpecsOpts): SpecLibraryWorkflowEntry[] {
  let rows: SpecRow[] = [];
  try {
    rows = opts.db.prepare(
      `SELECT * FROM workflow_specs ORDER BY name, version`,
    ).all() as SpecRow[];
  } catch {
    // workflow_specs 表不存在（测试 harness 未应用 migration）时返回空 library，与 Slice Story
    // View v0 slice indexer 使用相同的优雅降级。
    return [];
  }

  const out: SpecLibraryWorkflowEntry[] = [];
  for (const row of rows) {
    const status: "valid" | "error" = row.status === "error" ? "error" : "valid";
    const isBuiltIn = opts.workflowBuiltinSpecsDir
      ? isUnderDir(row.source_path, opts.workflowBuiltinSpecsDir)
      : false;

    // Slice 11——diagnostic row 不带解析后的 payload。使用文件 basename 作为 row label
    //（writeDiagnostic 已存入 name），计数为零，errorMessage 携带原因。
    if (status === "error") {
      out.push({
        // Diagnostic row 没有稳定的 name+version（YAML 无法解析时 version 为空）；library id
        // 回退到 source_path，使 UI 可以唯一寻址。
        id: `workflow:error:${row.source_path}`,
        kind: "workflow",
        name: row.name,
        version: row.version,
        sourceType: isBuiltIn ? "builtin" : "user_file",
        sourcePath: row.source_path,
        relativePath: row.source_path,
        updatedAt: row.cached_at,
        summary: row.error_message ?? undefined,
        isBuiltIn,
        rolesCount: 0,
        stepsCount: 0,
        terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
        targetRig: null,
        status: "error",
        errorMessage: row.error_message ?? null,
      });
      continue;
    }

    let roles: WorkflowSpec["roles"];
    let steps: WorkflowSpec["steps"];
    try {
      roles = JSON.parse(row.roles_json) as WorkflowSpec["roles"];
      steps = JSON.parse(row.steps_json) as WorkflowSpec["steps"];
    } catch {
      // cache 中 JSON 格式错误时跳过，不生成 entry；后台服务 /api/workflow/specs surface
      // 仍会呈现该 row。
      continue;
    }
    out.push({
      // 从 name+version 派生稳定 id，使 SpecLibrary review endpoint 能像按 id 解析 rig/agent
      // entry 一样解析 workflow entry。
      id: workflowLibraryId(row.name, row.version),
      kind: "workflow",
      name: row.name,
      version: row.version,
      sourceType: isBuiltIn ? "builtin" : "user_file",
      sourcePath: row.source_path,
      relativePath: row.source_path,
      updatedAt: row.cached_at,
      summary: row.purpose ?? undefined,
      isBuiltIn,
      rolesCount: Object.keys(roles ?? {}).length,
      stepsCount: Array.isArray(steps) ? steps.length : 0,
      terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
      targetRig: row.target_rig,
      status: "valid",
      errorMessage: null,
    });
  }
  return out;
}

export function getWorkflowReview(opts: ScanWorkflowSpecsOpts & { name: string; version: string }): SpecLibraryWorkflowReview | null {
  let row: SpecRow | undefined;
  try {
    row = opts.db.prepare(
      `SELECT * FROM workflow_specs WHERE name = ? AND version = ?`,
    ).get(opts.name, opts.version) as SpecRow | undefined;
  } catch {
    return null;
  }
  if (!row) return null;

  let roles: WorkflowSpec["roles"];
  let steps: WorkflowSpec["steps"];
  try {
    roles = JSON.parse(row.roles_json) as WorkflowSpec["roles"];
    steps = JSON.parse(row.steps_json) as WorkflowSpec["steps"];
  } catch {
    return null;
  }

  const isBuiltIn = opts.workflowBuiltinSpecsDir
    ? isUnderDir(row.source_path, opts.workflowBuiltinSpecsDir)
    : false;

  // 投影 topology，使用与 Slice Story View v1 相同的结构。
  const stepByRole = new Map<string, typeof steps[0]>();
  for (const step of steps ?? []) {
    if (!stepByRole.has(step.actor_role)) stepByRole.set(step.actor_role, step);
  }
  const entryRole = (row as unknown as { entry_role?: string }).entry_role
    ?? steps?.[0]?.actor_role;
  const entryStepId = entryRole ? stepByRole.get(entryRole)?.id : undefined;

  const stepIds = new Set((steps ?? []).map((s) => s.id));
  const topologyNodes = (steps ?? []).map((step) => {
    const roleSpec = (roles as Record<string, { preferred_targets?: string[] }>)[step.actor_role] ?? {};
    // OPR.0.4.6.WF4 Q1-P3：带 next_hop.on target 的 step 不是 terminal；这修正了
    // build/verify 等纯 branch step 的 false-terminal 缺陷。
    const hasOnTargets = Object.keys(step.next_hop?.on ?? {}).length > 0;
    return {
      stepId: step.id,
      role: step.actor_role,
      objective: step.objective ?? null,
      preferredTarget: roleSpec.preferred_targets?.[0] ?? null,
      isEntry: step.id === entryStepId,
      isTerminal: !(step.next_hop?.suggested_roles?.length) && !hasOnTargets,
      // OPR.0.4.6.WF4 Q1-P1：可选 node 字段，缺失时省略。通过省略保持字节身份：未声明
      // 这些字段的 step 不增加任何 key。
      ...(step.harness ? { harness: step.harness } : {}),
      ...(step.host ? { host: step.host } : {}),
      ...(step.gate ? { gate: step.gate } : {}),
    };
  });

  const topologyEdges: SpecLibraryWorkflowReview["topology"]["edges"] = [];
  for (const step of steps ?? []) {
    for (const role of step.next_hop?.suggested_roles ?? []) {
      const target = stepByRole.get(role);
      if (!target) continue;
      topologyEdges.push({ fromStepId: step.id, toStepId: target.id, routingType: "direct" });
    }
    // OPR.0.4.6.WF4 Q1-P2：从 next_hop.on 生成 branch edge（exit → successor STEP ID）。
    // 缺少 `on` 时不 push，因此只含 suggested_roles 的 spec 会投影出逐字节相同的 edge array。
    // exit label 通过 `branchOn` 传递。
    for (const [exit, targetStepId] of Object.entries(step.next_hop?.on ?? {})) {
      if (!targetStepId || !stepIds.has(targetStepId)) continue;
      topologyEdges.push({
        fromStepId: step.id,
        toStepId: targetStepId,
        routingType: "branch",
        branchOn: exit as WorkflowExitKind,
      });
    }
  }

  const stepDetails: SpecLibraryWorkflowReview["steps"] = (steps ?? []).map((step) => ({
    stepId: step.id,
    role: step.actor_role,
    objective: step.objective ?? null,
    allowedExits: [...(step.allowed_exits ?? [])],
    allowedNextSteps: (step.next_hop?.suggested_roles ?? [])
      .map((role) => {
        const target = stepByRole.get(role);
        return target ? { stepId: target.id, role } : null;
      })
      .filter((x): x is { stepId: string; role: string } => x !== null),
  }));

  return {
    kind: "workflow",
    name: row.name,
    version: row.version,
    purpose: row.purpose,
    targetRig: row.target_rig,
    terminalTurnRule: row.coordination_terminal_turn_rule || "hot_potato",
    rolesCount: Object.keys(roles ?? {}).length,
    stepsCount: (steps ?? []).length,
    isBuiltIn,
    sourcePath: row.source_path,
    cachedAt: row.cached_at,
    topology: { nodes: topologyNodes, edges: topologyEdges },
    steps: stepDetails,
  };
}

export function workflowLibraryId(name: string, version: string): string {
  return `workflow:${name}:${version}`;
}

export function parseWorkflowLibraryId(id: string): { name: string; version: string } | null {
  if (!id.startsWith("workflow:")) return null;
  const rest = id.slice("workflow:".length);
  // version 可以是数字或任意字符串；按最后一个 `:` 分割。
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;
  return { name: rest.slice(0, lastColon), version: rest.slice(lastColon + 1) };
}

function isUnderDir(childPath: string, parentDir: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return false;
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}

// =================================================================
// Slice 11（release-0.3.1 workflow-spec-folder-discovery）
// =================================================================
//
// scanWorkflowSpecFolder——遍历文件系统，把 workspace.specs_root/workflows/ 转换成可安装的
// user primitive。Library 路由在每次 list 请求时择机调用（OQ-3 裁定）；有效 YAML 经现有
// WorkflowSpecCache.readThrough 路径缓存，无效 YAML 经 slice 11 writeDiagnostic 路径缓存；
// 上次扫描后消失的文件通过 removeBySourcePath 移除（OQ-4 裁定：删除 + audit log）。
//
// OQ-3 mtime 检查：mtime <= cache row.cached_at 时跳过文件，无需 parse。否则经 cache 重新
// parse；cache 自身会计算内容 hash，匹配时返回旧 row，作为内容不变但 mtime 前进（例如 touch）
// 时的第二层跳过。

export interface ScanWorkflowSpecFolderOpts {
  /** SQLite handle，用于直接查询。 */
  db: Database.Database;
  /** readThrough / writeDiagnostic / removeBySourcePath 使用的 cache handle。 */
  cache: WorkflowSpecCache;
  /** 工作区 workflows 文件夹的绝对路径，通常为 `<workspace.specs_root>/workflows`。
   *  文件夹缺失时返回空扫描摘要，不算错误。 */
  folder: string;
  /** 后台服务随附的 builtin starter 目录；用于跳过 built-in row 的移除逻辑，因为 scanner
   *  只拥有自己遍历的文件夹。 */
  builtinDir: string | null;
  /** 可选 EventBus。接线后，每个因 source file 消失而移除的 cache row 都会发出
   *  workflow_spec.removed audit event（OQ-4 acceptance：删除 + audit log）。不关心 emission
   *  的单元测试可省略。 */
  eventBus?: EventBus;
}

export interface ScanWorkflowSpecFolderResult {
  /** 文件夹中发现的 YAML/YML 文件总数。 */
  scanned: number;
  /** 本次扫描成功 parse 并缓存的文件数。 */
  valid: number;
  /** parse/validate 失败并记录为 diagnostic row 的文件数。 */
  errors: number;
  /** 因 source_path 不再存在而移除的 cache row 数。 */
  removed: number;
  /** 通过 mtime 检查发现自上次扫描后未变化，从而跳过的文件数。 */
  skipped: number;
}

function isWorkflowYamlFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

export function scanWorkflowSpecFolder(
  opts: ScanWorkflowSpecFolderOpts,
): ScanWorkflowSpecFolderResult {
  const result: ScanWorkflowSpecFolderResult = {
    scanned: 0,
    valid: 0,
    errors: 0,
    removed: 0,
    skipped: 0,
  };
  if (!existsSync(opts.folder)) return result;

  let entries: string[] = [];
  try {
    entries = readdirSync(opts.folder);
  } catch {
    return result;
  }

  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (!isWorkflowYamlFile(entry)) continue;
    const filePath = path.join(opts.folder, entry);
    let mtimeMs = 0;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    seenPaths.add(filePath);
    result.scanned += 1;

    // mtime 检查（OQ-3）：若 cache 中该 source_path row 的 cached_at 不早于文件 mtime，
    // 说明文件自上次扫描后未变化，完全跳过重新 parse。
    //
    // 按秒精度比较，因为 HFS+、FAT 等文件系统会把 mtime 向下舍入到整秒，而 cached_at 保留
    // 毫秒精度。若不取 floor，mtime 为 `T - 999ms` 的新写文件会始终看起来比恰好位于 `T` 的
    // cached_at 更新，从而永远无法跳过。
    const cachedAt = opts.db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE source_path = ?`)
      .get(filePath) as { cached_at: string } | undefined;
    if (cachedAt) {
      const cachedAtMs = Date.parse(cachedAt.cached_at);
      const cachedAtSec = Math.floor(cachedAtMs / 1000);
      const mtimeSec = Math.floor(mtimeMs / 1000);
      if (Number.isFinite(cachedAtMs) && cachedAtSec >= mtimeSec) {
        result.skipped += 1;
        continue;
      }
    }

    // 通过 cache parse + validate。readThrough 因 parse/validation error 抛错时，记录以
    // source_path 为 key 的 diagnostic row，使 Library UI 可内联渲染错误。
    try {
      opts.cache.readThrough(filePath);
      result.valid += 1;
    } catch (err) {
      // 诊断：尽力计算原始内容 hash，以检测修复错误的编辑；仅靠 mtime 已足够，这里用于记账。
      // 内容不可读时使用空字符串。
      const message = err instanceof Error ? err.message : String(err);
      let sourceHash = "";
      try {
        sourceHash = createHash("sha256").update(readFileSync(filePath, "utf-8")).digest("hex");
      } catch {
        // 在 stat 与 read 之间变得不可读或消失时使用空 hash，让下次扫描重新评估。
        sourceHash = "";
      }
      opts.cache.writeDiagnostic({
        sourcePath: filePath,
        sourceHash,
        errorMessage: message,
      });
      result.errors += 1;
    }
  }

  // OQ-4 删除：source_path 位于扫描文件夹下且磁盘文件已不存在的 cache row 会被移除。通过
  // source_path prefix 限定删除范围，避免触碰 built-in row 或 scanner 不拥有的 row，例如其他
  // workflows 文件夹。
  const folderPrefix = opts.folder.endsWith(path.sep) ? opts.folder : `${opts.folder}${path.sep}`;
  const cachedUnderFolder = opts.db
    .prepare(
      `SELECT source_path, spec_id, name, version FROM workflow_specs WHERE source_path LIKE ?`,
    )
    .all(`${folderPrefix}%`) as Array<{
      source_path: string;
      spec_id: string | null;
      name: string | null;
      version: string | null;
    }>;
  for (const row of cachedUnderFolder) {
    if (seenPaths.has(row.source_path)) continue;
    const removed = opts.cache.removeBySourcePath(row.source_path);
    if (removed > 0) {
      result.removed += removed;
      // OQ-4 audit log：记录文件消失，使操作员能追踪何时回收了哪个 spec。emission 失败不能
      // 中止扫描，因为 cache row 已被删除，下次扫描对该路径也只会 no-op。
      if (opts.eventBus) {
        try {
          opts.eventBus.emit({
            type: "workflow_spec.removed",
            sourcePath: row.source_path,
            specId: row.spec_id ?? null,
            specName: row.name ?? null,
            specVersion: row.version ?? null,
            reason: "file_disappeared",
          });
        } catch { /* 尽力发出 audit event。 */ }
      }
    }
  }

  return result;
}
