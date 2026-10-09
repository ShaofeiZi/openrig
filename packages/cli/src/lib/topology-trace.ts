// OPR.0.5.3.6 —— 产品化的链式文件追踪（CE-v2）。
//
// 拓扑树在四个已交付层级上携带派生上下文，实例层位于根的【顶端】（D2）：
//
//   <topology.root>/<NAME>                          —— 实例
//   <topology.root>/rigs/<rig>/<NAME>               —— 工作组
//   <topology.root>/rigs/<rig>/pods/<pod>/<NAME>    —— pod
//   <topology.root>/rigs/<rig>/seats/<seat>/<NAME>  —— 席位
//
// 根来自带类型的 `topology.root` 配置键——绝不硬编码字面量（D1）。
// 约定前的旧位置（resolveLegacyTopologyRigsRoot）仍作为逐级回退可读，
// 但【必须】给出具名提示：读取成功，并告知调用方内容来自旧树以及如何迁移。
// 旧字面量只集中在本文件的一个辅助函数里（与 daemon settings-store 的
// resolveLegacyTopologyRigsRoot 是 CLI 孪生），因此遍历本身不含路径字面量。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLegacyTopologyRigsRoot } from "../config-store.js";

export type TraceAltitude = "instance" | "rig" | "pod" | "seat";

export interface TraceLevel {
  altitude: TraceAltitude;
  /** 该层级在 topology.root 下的规范路径。 */
  path: string;
  /** 内容实际找到的位置：规范路径、旧树，或未找到。 */
  source: "topology.root" | "legacy" | "absent";
  /** 内容实际读取自的路径（规范或旧）；未找到时为 null。 */
  resolvedPath: string | null;
  content: string | null;
  /** 仅当 source === "legacy" 时存在——具名提示。 */
  advisory?: string;
}

export interface TraceResult {
  name: string;
  topologyRoot: string;
  /** 从根开始：实例、工作组、可选 pod、可选席位——由泛到专。 */
  levels: TraceLevel[];
}

export interface TraceFs {
  exists(path: string): boolean;
  read(path: string): string;
}

/** r2-B3：rig、seat、name 各自都必须是【一个】安全路径段。未校验的值拼进文件系统路径，
 *  会让 `--rig ../../outside` 把每一层都解析到 topology.root【之外】
 *  （评审者的判别用例已证明）。拒绝发生在【任何】文件系统接触之前。
 *  带点的文件名（a.b.c.md）与横线/下划线 id 仍合法；分隔符、点段、空段、NUL 不合法。 */
function assertSafeSegment(value: string, field: "rig" | "pod" | "seat" | "name"): void {
  if (
    value.trim().length === 0
    || value === "." || value === ".."
    || value.includes("/") || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(
      `非法的 ${field} "${value}"：必须是不含分隔符或点段的非空白单段路径`,
    );
  }
}

const realFs: TraceFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf-8"),
};

/**
 * 为某个链式文件名遍历拓扑树。`seat` 可选（工作组级追踪在工作组层即停）。
 * 给定 `fs` 时为纯函数——测试可注入。
 */
export function traceTopologyChain(input: {
  topologyRoot: string;
  name: string;
  rig: string;
  pod?: string | null;
  seat?: string | null;
  legacyRigsRoot?: string;
  fs?: TraceFs;
}): TraceResult {
  assertSafeSegment(input.rig, "rig");
  if (input.pod != null) assertSafeSegment(input.pod, "pod");
  // r2 遗留项：显式【空】seat 属于用户错误——只有真正省略（undefined/null）
  // 才表示工作组级追踪。
  if (input.seat != null) assertSafeSegment(input.seat, "seat");
  assertSafeSegment(input.name, "name");

  const fs = input.fs ?? realFs;
  const legacyRigsRoot = input.legacyRigsRoot ?? resolveLegacyTopologyRigsRoot();

  const levels: Array<{ altitude: TraceAltitude; canonical: string; legacy: string | null }> = [
    // 实例层就是树的根——不存在旧版等价物（旧布局从 rigs/ 开始）。
    { altitude: "instance", canonical: join(input.topologyRoot, input.name), legacy: null },
    {
      altitude: "rig",
      canonical: join(input.topologyRoot, "rigs", input.rig, input.name),
      legacy: join(legacyRigsRoot, input.rig, input.name),
    },
    ...(input.pod
      ? [{
          altitude: "pod" as const,
          canonical: join(input.topologyRoot, "rigs", input.rig, "pods", input.pod, input.name),
          legacy: null,
        }]
      : []),
    ...(input.seat
      ? [{
          altitude: "seat" as const,
          canonical: join(input.topologyRoot, "rigs", input.rig, "seats", input.seat, input.name),
          legacy: join(legacyRigsRoot, input.rig, "seats", input.seat, input.name),
        }]
      : []),
  ];

  return {
    name: input.name,
    topologyRoot: input.topologyRoot,
    levels: levels.map(({ altitude, canonical, legacy }): TraceLevel => {
      if (fs.exists(canonical)) {
        return { altitude, path: canonical, source: "topology.root", resolvedPath: canonical, content: fs.read(canonical) };
      }
      if (legacy && fs.exists(legacy)) {
        return {
          altitude,
          path: canonical,
          source: "legacy",
          resolvedPath: legacy,
          content: fs.read(legacy),
          advisory:
            `legacy-topology-read：${altitude} 层的 "${input.name}" 在约定前的旧位置 ` +
            `${legacy} 找到，而非位于 topology.root（${input.topologyRoot}）之下。读取已成功；请将此文件迁移到 ` +
            `${canonical}（见链式文件约定文档；\`zrig config get topology.root\` 可查看根）。`,
        };
      }
      return { altitude, path: canonical, source: "absent", resolvedPath: null, content: null };
    }),
  };
}
