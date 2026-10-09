// OPR.0.4.4.11——拓扑 manifest：可共享产物（FR-1）。
//
// 键集合封闭（架构回传 R11-1——这正是精简 manifest 的强制约束）：只允许有序 `rigs[]`
// 条目 {source, host?}，以及可选的 manifest 级 `concurrency` 上限（默认 1，即串行）。
// 不允许其他内容。未知键会明确拒绝；静默忽略会暗中重新引入创建者已批准的非目标。跨工作组
// edge/routing/dependency 键会在错误中点明该非目标（精简 manifest；工作组间路由延后到
// topology-Q1）。v0 曾考虑但移除了 `on_failure`（spec-guard + 架构折叠）：唯一行为是失败即
// 停止；重新加入必须由 pm-lead 显式决定。
//
// 检测契约（PRD FR-1 + guard G-1 折叠；路由器消费导出的探测函数）：扩展名为
// `.rigtopology`，或 YAML 文档顶层有 `rigs:` 列表。两者同时适用时扩展名优先
//（架构裁决 1——声明类型具有约束力）；`.rigtopology` 校验失败时按拓扑报错，绝不回退到
// rig-spec 解析。
//
// 未知主机 ID 校验（FR-1 第四类结构错误）由启动器在启动前校验阶段，通过共享
// hosts-registry-reader 对照主机注册表解析；仍早于任何启动尝试。本模块按设计不依赖
// 文件系统或注册表。

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface TopologyRigEntry {
  source: string;
  host?: string;
}

export interface TopologyManifest {
  rigs: TopologyRigEntry[];
  /** 规范化值：manifest 上限，未提供时默认为 1（串行）。 */
  concurrency: number;
}

export type TopologyManifestResult =
  | { ok: true; manifest: TopologyManifest }
  | { ok: false; errors: string[] };

/** 已批准的非目标族：任何会把跨工作组边、路由或依赖语义夹带进精简 manifest 的键。 */
const EDGE_ROUTING_KEYS = new Set([
  "edge",
  "edges",
  "route",
  "routes",
  "routing",
  "dependency",
  "dependencies",
  "deps",
  "depends_on",
  "dependsOn",
  "needs",
  "after",
  "links",
  "wires",
  "connections",
]);

const MANIFEST_KEYS = new Set(["rigs", "concurrency"]);
const ENTRY_KEYS = new Set(["source", "host"]);

function edgeRoutingRejection(prefix: string, key: string): string {
  return `${prefix}：'${key}' 是跨工作组 edge/routing/dependency 键——已拒绝。拓扑 manifest 刻意保持精简（创建者批准的非目标：不支持跨工作组边和路由语义；工作组间路由延后到 topology-Q1 决策）。请移除此键；manifest 只携带 rigs[]{source, host?} + concurrency。`;
}

function unknownKeyRejection(prefix: string, key: string, allowed: string): string {
  if (key === "on_failure") {
    return `${prefix}：v0 已移除 'on_failure'——唯一行为是失败即停止（遍历在第一个失败条目处停止；已启动工作组仍会如实报告）。重新加入该键必须由 pm-lead 显式决定。请移除它。`;
  }
  return `${prefix}：未知键 '${key}'——manifest 键集合封闭（${allowed}）。请移除或修正该键。`;
}

/** 将已解析的 YAML 文档校验为拓扑 manifest。收集每个结构错误（逐条说明问题、原因和修复），
 * 而不是快速失败；FR-1 会在任何启动前一次性报告全部错误。 */
export function validateTopologyManifest(parsed: unknown, sourcePath: string): TopologyManifestResult {
  const where = `位于 ${sourcePath} 的拓扑 manifest`;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [`${where}：必须是顶层包含 'rigs' 列表的 YAML 对象`] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(obj)) {
    if (MANIFEST_KEYS.has(key)) continue;
    if (EDGE_ROUTING_KEYS.has(key)) {
      errors.push(edgeRoutingRejection(where, key));
    } else {
      errors.push(unknownKeyRejection(where, key, "'rigs' + optional 'concurrency'"));
    }
  }

  let concurrency = 1;
  const rawConcurrency = obj["concurrency"];
  if (rawConcurrency !== undefined) {
    if (typeof rawConcurrency !== "number" || !Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
      errors.push(
        `${where}：'concurrency' 必须是正整数（固定的分阶段启动上限；默认 1 = 串行；自适应限流不在范围内）——收到 ${JSON.stringify(rawConcurrency)}`,
      );
    } else {
      concurrency = rawConcurrency;
    }
  }

  const rigs = obj["rigs"];
  if (!Array.isArray(rigs)) {
    errors.push(`${where}：'rigs' 必须是 {source, host?} 条目列表，即有序启动计划`);
    return { ok: false, errors };
  }
  if (rigs.length === 0) {
    errors.push(`${where}：'rigs' 为空——拓扑必须至少指定一个要启动的工作组`);
    return { ok: false, errors };
  }

  const validated: TopologyRigEntry[] = [];
  for (let i = 0; i < rigs.length; i++) {
    const raw = rigs[i];
    const prefix = `${where}: rigs[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${prefix}：必须是包含工作组 'source' 引用和可选 'host' 的对象`);
      continue;
    }
    const entry = raw as Record<string, unknown>;

    for (const key of Object.keys(entry)) {
      if (ENTRY_KEYS.has(key)) continue;
      if (EDGE_ROUTING_KEYS.has(key)) {
        errors.push(edgeRoutingRejection(prefix, key));
      } else {
        errors.push(unknownKeyRejection(prefix, key, "'source' + optional 'host'"));
      }
    }

    const source = entry["source"];
    if (typeof source !== "string" || source.trim() === "") {
      errors.push(`${prefix}.source：必须是非空字符串，即工作组 SPEC PATH（v0 边界；各形式拒绝原因见下文）`);
      continue;
    }
    // ── v0 source 形式边界（架构裁决 2026-07-05，guard F2/F3 折叠）：拓扑条目只允许
    // SPEC PATH，并在解析阶段拒绝其他形式。统一条目语义优于遍历中途失败，两种放宽都非免费：
    // bundle targetRoot 是受 pm 门禁的封闭键扩展（R11-1）；库名称需要后台服务解析接缝
    //（P4-adjacent+）。两者都明确延后。直接调用 zrig up 的形式不受影响（保持 FR-2）。
    if (/\.rigbundle$/i.test(source)) {
      errors.push(
        `${prefix}.source：v0 不支持 '.rigbundle' 条目——拓扑条目只允许 SPEC PATH（bundle 条目需要显式的逐条 targetRoot，这是受 pm 门禁的封闭键集合扩展，已延后）。替代方案：直接启动该工作组；单工作组命令 'zrig up ${source}' 仍接受所有源类型。`,
      );
      continue;
    }
    if (/\.rigtopology$/i.test(source)) {
      errors.push(`${prefix}.source：不支持嵌套拓扑 manifest——每个条目都必须是单工作组 spec 路径。`);
      continue;
    }
    if (!source.includes("/") && !/\.ya?ml$/i.test(source)) {
      errors.push(
        `${prefix}.source：'${source}' 是裸库/工作组名称——v0 拓扑条目只允许 SPEC PATH（名称条目需要后台服务侧解析接缝，已延后）。替代方案：单独运行 'zrig up ${source}'，或按路径引用其 spec 文件。`,
      );
      continue;
    }
    const host = entry["host"];
    if (host !== undefined && (typeof host !== "string" || host.trim() === "")) {
      errors.push(`${prefix}.host：此字段可选，但提供时必须是已注册的非空主机 ID（逐条 'host:' 是唯一拓扑放置机制）`);
      continue;
    }
    validated.push({ source, ...(host !== undefined ? { host: host as string } : {}) });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { rigs: validated, concurrency } };
}

/** 加载、解析并校验拓扑 manifest 文件。解析失败时按拓扑报错（架构裁决 1：声明类型具有
 * 约束力，不回退到 rig-spec）。 */
export function loadTopologyManifest(path: string): TopologyManifestResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      errors: [
        `在 ${path} 未找到拓扑 manifest。请创建 .rigtopology YAML 文件，顶层包含由 {source, host?} 条目组成的 'rigs:' 列表，并可选提供 'concurrency'。`,
      ],
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, errors: [`读取 ${path} 中的拓扑 manifest 失败：${(err as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, errors: [`解析 ${path} 中的拓扑 manifest YAML 失败：${(err as Error).message}`] };
  }
  return validateTopologyManifest(parsed, path);
}

/** 检测探针（FR-1 + guard G-1/yaml 折叠）：当且仅当已解析 YAML 文档顶层携带 `rigs:`
 * 列表时，它才具有拓扑结构。工作组 spec 从不在顶层携带 `rigs`，因此探测无歧义。此处只
 * 检查形态；之后仍会按拓扑执行完整校验并在必要时拒绝。 */
export function hasTopLevelRigsList(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Array.isArray((parsed as Record<string, unknown>)["rigs"]);
}

/** 供尚未解析内容的路由分支使用的原始文本探针（无扩展名路径形式的回退）。无法解析的
 * YAML 探测为 false，随后原样进入既有非拓扑处理。 */
export function yamlTextHasTopLevelRigsList(raw: string): boolean {
  try {
    return hasTopLevelRigsList(parseYaml(raw));
  } catch {
    return false;
  }
}
