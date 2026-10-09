// OPR.0.4.8.3——内建策略打包/物化固定值（护栏封存的不可变计划 v2 eea3c778，D4）。
// 四项内建策略逐字发行：标准仓库源为
// packages/daemon/policies/builtin/<name>.policy.md，并以 0444 模式的只读检查副本
// 物化到 $OPENRIG_HOME/reference/policies/builtin/（护栏裁定：这是复制后自定义的便利
// 能力，不是安全边界；没有写入接口；用户自定义副本不受修改）。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_POLICY_NAMES, materializeBuiltinPolicyReference } from "../src/domain/builtin-policy-reference.js";

const REPO_BUILTIN_DIR = resolve(import.meta.dirname, "../policies/builtin");

/** 四项权威内容固定值（workspace/incoming/slice03-core-authoritative，PM 内联内建
 * 裁定）——完整 64 位十六进制值，逐字复制到仓库源中。 */
const AUTHORITY_SHA256: Record<string, string> = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "737d3f56e6d8275fe548a3a06e9b02ede8f328207ec2e6223cea6a83f40f5148",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "1c34fff0b385426689fd26e20b8b431de6b688028d584924e7d5384fe5ff6d42",
};

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function tempTarget(): string {
  return mkdtempSync(join(tmpdir(), "builtin-policy-ref-"));
}

describe("T1/T2——标准仓库源：恰好四项已知清单、逐字节一致", () => {
  it("packages/daemon/policies/builtin 恰好包含四个内建策略文件", () => {
    const files = readdirSync(REPO_BUILTIN_DIR).filter((file) => /^(locked|open|standard|yolo)\.policy\.md$/.test(file)).sort();
    expect(files).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"]);
  });

  it("每个仓库源文件都与其权威来源逐字节一致（完整 sha256 固定值）", () => {
    for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
      expect(sha256(join(REPO_BUILTIN_DIR, file)), file).toBe(hash);
    }
  });
});

describe("T3/T4/T5——物化器：逐字节一致的 0444 检查副本、幂等、受允许列表约束", () => {
  it("T3：将已知四项逐字节复制到目标，并设为 0444 模式", () => {
    const target = tempTarget();
    try {
      const result = materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      expect(result.written.sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"]);
      expect(result.skipped).toEqual([]);
      for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
        const p = join(target, file);
        expect(sha256(p), file).toBe(hash);
        expect(statSync(p).mode & 0o777, `${file} mode`).toBe(0o444);
      }
      expect(readdirSync(target)).toHaveLength(4); // 未物化任何额外内容
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("T4：刷新会恢复遭篡改的现有只读副本；跳过内容时仍会协调模式", () => {
    const target = tempTarget();
    try {
      materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      // 篡改只读副本（模拟操作员在 chmod 后编辑），并保持只读
      const victim = join(target, "locked.policy.md");
      chmodSync(victim, 0o644);
      writeFileSync(victim, "tampered — not the policy\n");
      chmodSync(victim, 0o444);
      // 同时破坏最新副本的模式（内容不变）
      chmodSync(join(target, "yolo.policy.md"), 0o644);
      materializeBuiltinPolicyReference({ bundledDir: REPO_BUILTIN_DIR, targetDir: target });
      expect(sha256(victim)).toBe(AUTHORITY_SHA256["locked.policy.md"]); // 字节已恢复
      expect(statSync(victim).mode & 0o777).toBe(0o444);
      expect(statSync(join(target, "yolo.policy.md")).mode & 0o777, "跳过内容的路径会协调模式").toBe(0o444);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("T5：捆绑目录中的陌生文件绝不复制；单个源缺失时具名跳过，其余仍写入", () => {
    const bundled = tempTarget();
    const target = tempTarget();
    try {
      for (const file of ["locked.policy.md", "standard.policy.md", "open.policy.md"])
        writeFileSync(join(bundled, file), readFileSync(join(REPO_BUILTIN_DIR, file)));
      writeFileSync(join(bundled, "rogue.policy.md"), "不是内建策略\n"); // 陌生文件
      const result = materializeBuiltinPolicyReference({ bundledDir: bundled, targetDir: target });
      expect(result.written.sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md"]);
      expect(result.skipped).toEqual(["yolo.policy.md"]); // 具名记录缺失源，绝不抛错
      expect(readdirSync(target).sort()).toEqual(["locked.policy.md", "open.policy.md", "standard.policy.md"]);
    } finally {
      rmSync(bundled, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("缺少捆绑目录时全部跳过（尽力而为），绝不抛错", () => {
    const target = tempTarget();
    try {
      const result = materializeBuiltinPolicyReference({ bundledDir: join(target, "does-not-exist"), targetDir: target });
      expect(result.written).toEqual([]);
      expect(result.skipped.sort()).toEqual([...BUILTIN_POLICY_NAMES].map((n) => `${n}.policy.md`).sort());
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
