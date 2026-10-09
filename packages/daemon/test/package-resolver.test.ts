import { describe, it, expect, vi } from "vitest";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";

const VALID_MANIFEST = `
schema_version: 1
name: test-pkg
version: 1.0.0
summary: A test package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
`;

const INVALID_MANIFEST = `
schema_version: 1
name: test-pkg
`;

function mockFs(files: Record<string, string>): FsOps {
  return {
    readFile: vi.fn((p: string) => {
      if (files[p]) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => p in files),
  };
}

describe("PackageResolver", () => {
  // Test 1：解析绝对路径 → 找到 package.yaml，解析并规范化，返回正确的 sourceRef/sourceKind
  it("解析绝对路径 → 清单 + 源标识", () => {
    const fs = mockFs({
      "/packages/my-pkg/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);
    const result = resolver.resolve("/packages/my-pkg");

    expect(result.sourceKind).toBe("local_path");
    expect(result.sourceRef).toBe("/packages/my-pkg");
    expect(result.manifest.name).toBe("test-pkg");
    expect(result.manifest.version).toBe("1.0.0");
    expect(result.manifest.summary).toBe("A test package");
    expect(result.manifest.exports.skills).toHaveLength(1);
  });

  // Test 2：解析缺失 package.yaml → 错误
  it("解析无 package.yaml 的路径 → 错误", () => {
    const fs = mockFs({});
    const resolver = new PackageResolver(fs);

    expect(() => resolver.resolve("/packages/empty")).toThrow(/未找到 package\.yaml/);
  });

  // Test 3：解析非法清单 → 校验错误
  it("解析带非法清单的路径 → 校验错误", () => {
    const fs = mockFs({
      "/packages/bad/package.yaml": INVALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);

    expect(() => resolver.resolve("/packages/bad")).toThrow(/manifest 无效/);
  });

  // Test 4：哈希确定性（同一清单 → 同一哈希）
  it("清单哈希确定性（同内容 → 同一 SHA-256）", () => {
    const fs = mockFs({
      "/pkg1/package.yaml": VALID_MANIFEST,
      "/pkg2/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);

    const r1 = resolver.resolve("/pkg1");
    const r2 = resolver.resolve("/pkg2");

    expect(r1.manifestHash).toBe(r2.manifestHash);
    expect(r1.manifestHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256
  });

  // Test 9：相对路径按 cwd 解析 → 返回正确的绝对 sourceRef
  it("相对 cwd 解析相对路径 → 绝对 sourceRef", () => {
    const fs = mockFs({
      "/home/user/code/my-pkg/package.yaml": VALID_MANIFEST,
    });
    const resolver = new PackageResolver(fs);
    const result = resolver.resolve("./my-pkg", "/home/user/code");

    expect(result.sourceKind).toBe("local_path");
    expect(result.sourceRef).toBe("/home/user/code/my-pkg");
    expect(result.manifest.name).toBe("test-pkg");
  });
});
