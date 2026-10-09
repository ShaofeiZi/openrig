// OPR.0.4.1.11.2（FR-5）——twin 捕获的确定性产物命名 + 放置。
// 捕获包装（twin:capture）必须把每 slice 产物放在稳定、
// 防冲突、确定性布局下，使产物挂到某个 IMPL-PRD 且
// 同一输入总产出同一路径（喂给 FR-2 的"确定性命名" + D-1）。
// 约定根植于既有 digital-twin/ 实践（<surface>.intent.png /
// .intent.html，每 slice 文件夹）；精确根路径 + normalize-existing 决策
// 已升级（Open-Q3）——此 resolver 取 outRoot 为参数，使策略外置。
import { describe, it, expect } from "vitest";
import { resolveArtifactPaths } from "../twin/capture/artifact-paths.js";

describe("resolveArtifactPaths (OPR.0.4.1.11.2 FR-5: deterministic artifact naming + placement)", () => {
  const outRoot = "/work/digital-twin";

  it("places a surface's artifacts under outRoot/<slice>/ as .intent.html / .intent.png / .change.diff", () => {
    const p = resolveArtifactPaths({ slice: "demo-slice", surface: "Topology Graph", outRoot });
    expect(p.dir).toBe("/work/digital-twin/demo-slice");
    expect(p.intentHtml).toBe("/work/digital-twin/demo-slice/topology-graph.intent.html");
    expect(p.intentPng).toBe("/work/digital-twin/demo-slice/topology-graph.intent.png");
    expect(p.changeDiff).toBe("/work/digital-twin/demo-slice/topology-graph.change.diff");
    // FR-6：proof 侧（真实已发布 UI）产物与 intent 按同一 base 配对——直接
    // 并排可比，格式相同，仅 .intent 与 .proof 不同。
    expect(p.proofPng).toBe("/work/digital-twin/demo-slice/topology-graph.proof.png");
  });

  it("slugifies a route-shaped surface name into a filesystem-safe base (slashes/underscores/case)", () => {
    const p = resolveArtifactPaths({ slice: "demo-slice", surface: "/topology/rig/rig_delivery", outRoot });
    expect(p.intentPng).toBe("/work/digital-twin/demo-slice/topology-rig-rig-delivery.intent.png");
  });

  it("is deterministic — identical inputs yield identical paths", () => {
    const a = resolveArtifactPaths({ slice: "demo-slice", surface: "Dash Board", outRoot });
    const b = resolveArtifactPaths({ slice: "demo-slice", surface: "Dash Board", outRoot });
    expect(a).toEqual(b);
  });

  // pm + brief1-curator 批准路径为 digital-twin/<slice-id>/，其中 slice-id 是
  // 带点 OPR id（如 opr-0.4.1.11.2）。slice 文件夹必须保留点（文件系统安全）；
  // 仅 surface base 完全 slugify。（上方 surface 测试已锁定 surface 规则。）
  it("preserves the dotted slice-id as the per-slice folder (ratified: digital-twin/<slice-id>/)", () => {
    const p = resolveArtifactPaths({ slice: "opr-0.4.1.11.2", surface: "Topology Graph", outRoot });
    expect(p.dir).toBe("/work/digital-twin/opr-0.4.1.11.2");
    expect(p.intentPng).toBe("/work/digital-twin/opr-0.4.1.11.2/topology-graph.intent.png");
  });

  it("lowercases + sanitizes the slice-id while preserving its dots", () => {
    const p = resolveArtifactPaths({ slice: "OPR-0.4.1.11.2", surface: "x", outRoot });
    expect(p.dir).toBe("/work/digital-twin/opr-0.4.1.11.2");
  });
});
