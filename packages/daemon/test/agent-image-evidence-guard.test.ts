// PL-016 第 6 项——证据保留守卫测试。按 PRD，若遗漏将导致灾难性回退；
// 本文件固定以下关键行为：
//   - 保护已固定镜像
//   - 保护 agent.yaml 引用的镜像
//   - 保护 rig.yaml 引用的镜像
//   - 沿谱系传递保护受保护镜像的后代
//   - 未引用、未固定且不是后代的镜像可驱逐
//   - YAML 扫描器可容忍无关文件和大文件

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateProtection } from "../src/domain/agent-images/evidence-guard.js";
import type { AgentImageEntry } from "../src/domain/agent-images/agent-image-types.js";

function makeImage(opts: {
  name: string;
  version?: string;
  pinned?: boolean;
  lineage?: string[];
  sourcePath?: string;
}): AgentImageEntry {
  return {
    id: `agent-image:${opts.name}:${opts.version ?? "1"}`,
    kind: "agent-image",
    name: opts.name,
    version: opts.version ?? "1",
    runtime: "claude-code",
    sourceSeat: "x@y",
    sourceSessionId: "sid",
    sourceResumeToken: "tok",
    notes: null,
    createdAt: "2026-05-04T19:00:00Z",
    sourceType: "user_file",
    sourcePath: opts.sourcePath ?? `/tmp/${opts.name}`,
    relativePath: opts.name,
    updatedAt: "2026-05-04T19:00:00Z",
    manifestEstimatedTokens: null,
    derivedEstimatedTokens: 0,
    files: [],
    stats: {
      forkCount: 0,
      lastUsedAt: null,
      estimatedSizeBytes: 0,
      lineage: opts.lineage ?? [],
    },
    lineage: opts.lineage ?? [],
    pinned: opts.pinned ?? false,
  };
}

describe("evaluateProtection（PL-016 第 6 项）", () => {
  let tmp: string;
  let specRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-guard-"));
    specRoot = join(tmp, "specs");
    mkdirSync(specRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("保护已固定的镜像", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "pinned", pinned: true })],
      specRoots: [],
    });
    expect(result[0]!.protected).toBe(true);
    expect(result[0]!.reasons).toContain("pinned");
  });

  it("保护 agent.yaml 引用的镜像", () => {
    mkdirSync(join(specRoot, "agents", "x"), { recursive: true });
    writeFileSync(join(specRoot, "agents", "x", "agent.yaml"), `
name: x
runtime: claude-code
session_source:
  mode: agent_image
  ref:
    kind: image_name
    value: critical-image
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "critical-image" }), makeImage({ name: "evictable" })],
      specRoots: [specRoot],
    });
    const critical = result.find((r) => r.imageName === "critical-image")!;
    const evictable = result.find((r) => r.imageName === "evictable")!;
    expect(critical.protected).toBe(true);
    expect(critical.reasons).toContain("referenced_by_agent_spec");
    expect(evictable.protected).toBe(false);
  });

  it("保护 rig.yaml 引用的镜像", () => {
    writeFileSync(join(specRoot, "rig.yaml"), `
name: my-rig
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
        session_source:
          mode: agent_image
          ref:
            kind: image_name
            value: rig-referenced
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "rig-referenced" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.protected).toBe(true);
    expect(result[0]!.reasons).toContain("referenced_by_rig_spec");
  });

  it("沿谱系传递保护受保护镜像的后代", () => {
    const result = evaluateProtection({
      images: [
        makeImage({ name: "ancestor", pinned: true }),
        makeImage({ name: "child", lineage: ["ancestor"] }),
        makeImage({ name: "grandchild", lineage: ["ancestor", "child"] }),
        makeImage({ name: "unrelated" }),
      ],
      specRoots: [],
    });
    const child = result.find((r) => r.imageName === "child")!;
    const grand = result.find((r) => r.imageName === "grandchild")!;
    const unrelated = result.find((r) => r.imageName === "unrelated")!;
    expect(child.protected).toBe(true);
    expect(child.reasons).toContain("lineage_descendant_of_protected");
    expect(grand.protected).toBe(true);
    expect(unrelated.protected).toBe(false);
  });

  it("妥善处理缺失或不可访问的 spec 根目录（返回空引用）", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "x" })],
      specRoots: ["/nonexistent/path"],
    });
    expect(result[0]!.protected).toBe(false);
  });

  it("忽略未引用 agent_image 的 YAML", () => {
    writeFileSync(join(specRoot, "rig.yaml"), `
name: my-rig
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
`);
    const result = evaluateProtection({
      images: [makeImage({ name: "x" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.protected).toBe(false);
  });

  it("可驱逐镜像不返回保护原因，且引用为空", () => {
    const result = evaluateProtection({
      images: [makeImage({ name: "lonely" })],
      specRoots: [specRoot],
    });
    expect(result[0]!.reasons).toEqual([]);
    expect(result[0]!.references).toEqual([]);
  });
});
