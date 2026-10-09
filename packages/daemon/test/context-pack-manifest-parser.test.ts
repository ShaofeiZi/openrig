// 工作组上下文 / 可组合上下文注入 v0（PL-014）——manifest 解析器单元测试。

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

const validManifest = `
name: pl-005-priming
version: 1
taxonomy: mission
purpose: Priming for PL-005 Phase A
files:
  - path: prd.md
    role: prd
    summary: Phase A PRD
  - path: proof.md
    role: proof-packet
estimated_tokens: 500
`;

describe("parseManifest", () => {
  it("将有效 manifest 解析为类型化结构", () => {
    const m = parseManifest(validManifest, "/test/manifest.yaml");
    expect(m.name).toBe("pl-005-priming");
    expect(m.version).toBe("1");
    expect(m.purpose).toContain("Priming for PL-005");
    expect(m.files).toHaveLength(2);
    expect(m.files[0]).toEqual({ path: "prd.md", role: "prd", summary: "Phase A PRD" });
    expect(m.files[1]).toEqual({ path: "proof.md", role: "proof-packet" });
    expect(m.estimatedTokens).toBe(500);
  });

  it("将数字版本规范化为字符串", () => {
    const m = parseManifest("name: x\nversion: 2\ntaxonomy: world\nfiles: []", "/x.yaml");
    expect(m.version).toBe("2");
  });

  it("以 manifest_parse_error 拒绝非 YAML 内容", () => {
    expect(() => parseManifest("{not valid", "/x.yaml")).toThrow(ContextPackError);
    try {
      parseManifest("{not valid", "/x.yaml");
    } catch (err) {
      expect((err as ContextPackError).code).toBe("manifest_parse_error");
    }
  });

  it("拒绝缺少 name 的 manifest", () => {
    expect(() => parseManifest("version: 1\nfiles: []", "/x.yaml")).toThrow(/name/);
  });

  it("拒绝缺少 version 的 manifest", () => {
    expect(() => parseManifest("name: x\nfiles: []", "/x.yaml")).toThrow(/version/);
  });

  it("拒绝格式错误的 files 数组", () => {
    expect(() => parseManifest("name: x\nversion: 1\ntaxonomy: world\nfiles: not-an-array", "/x.yaml")).toThrow(/files/);
  });

  it("拒绝路径中包含 .. 的文件条目（越界尝试）", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: ../escape.md\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/pack 内的相对路径/);
  });

  it("拒绝使用绝对路径的文件条目", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: /etc/passwd\n    role: notes\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/pack 内的相对路径/);
  });

  it("拒绝后缀不受支持的文件条目", () => {
    // .ts/.sh 现在可提供服务（OPR.0.5.3.7 R2 辅助产物）；真正不受支持的后缀
    //（例如二进制文件）仍会被明确拒绝。
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: image.png\n    role: code\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/后缀不受支持/);
  });

  it("拒绝缺少 role 的文件条目", () => {
    const bad = "name: x\nversion: 1\ntaxonomy: world\nfiles:\n  - path: notes.md\n";
    expect(() => parseManifest(bad, "/x.yaml")).toThrow(/缺少 'role'/);
  });

  it("接受允许的后缀 md/markdown/yaml/yml/txt", () => {
    const ok = `name: x
version: 1
taxonomy: world
files:
  - { path: a.md, role: r }
  - { path: b.markdown, role: r }
  - { path: c.yaml, role: r }
  - { path: d.yml, role: r }
  - { path: e.txt, role: r }
`;
    const m = parseManifest(ok, "/x.yaml");
    expect(m.files).toHaveLength(5);
  });

  it("接受后缀为 sh/ts/mjs/py 的惰性 UTF-8 脚本辅助文件", () => {
    const ok = `name: helpers
version: 1
taxonomy: skills
files:
  - { path: scripts/a.sh, role: reference }
  - { path: scripts/b.ts, role: reference }
  - { path: scripts/c.mjs, role: reference }
  - { path: scripts/d.py, role: reference }
`;
    const m = parseManifest(ok, "/helpers.yaml");
    expect(m.files.map((file) => file.path)).toEqual([
      "scripts/a.sh",
      "scripts/b.ts",
      "scripts/c.mjs",
      "scripts/d.py",
    ]);
  });

  it("estimated_tokens 不是有限数值时忽略该字段", () => {
    const m = parseManifest("name: x\nversion: 1\ntaxonomy: world\nfiles: []\nestimated_tokens: 'not-a-number'", "/x.yaml");
    expect(m.estimatedTokens).toBeUndefined();
  });

  it("将具名安装 profile 解析为有序的 atom 与情境上下文阶段", () => {
    const manifest = parseManifest(`
name: world
version: 1
taxonomy: world
files:
  - { path: world.md, role: world }
atoms:
  - id: bootstrap
    address: world.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    runtime: any
    order: 10
    priority: core
  - id: coverage-map
    address: world.md#coverage-map
    taxonomy: world
    situations: [fresh]
    purpose: width
    runtime: any
    order: 20
    priority: core
    profile_only: true
profiles:
  - id: codex-coverage
    situations: [fresh]
    runtimes: [codex]
    phases:
      - id: bootstrap
        atoms: [bootstrap]
      - id: situated-work
        context: [project, mission, seat, slice]
      - id: coverage-map
        atoms: [coverage-map]
`, "/world/manifest.yaml");

    expect(manifest.atoms?.find((atom) => atom.id === "coverage-map")?.profileOnly).toBe(true);
    expect(manifest.profiles).toEqual([
      {
        id: "codex-coverage",
        situations: ["fresh"],
        runtimes: ["codex"],
        phases: [
          { id: "bootstrap", atoms: ["bootstrap"] },
          { id: "situated-work", context: ["project", "mission", "seat", "slice"] },
          { id: "coverage-map", atoms: ["coverage-map"] },
        ],
      },
    ]);
  });

  it("拒绝引用未声明 atom 的具名 profile", () => {
    const bad = `
name: world
version: 1
taxonomy: world
files: []
atoms:
  - id: declared
    address: project:SPEC.md
    taxonomy: mission
    situations: [fresh]
    purpose: width
    runtime: any
    order: 10
    priority: core
profiles:
  - id: codex-coverage
    situations: [fresh]
    runtimes: [codex]
    phases:
      - id: bootstrap
        atoms: [missing]
`;
    expect(() => parseManifest(bad, "/world/manifest.yaml")).toThrow(/profile.*missing|missing.*atom/i);
  });

  it("拒绝重复 atom 或上下文来源的具名 profile", () => {
    const prefix = `
name: world
version: 1
taxonomy: world
files:
  - { path: world.md, role: world }
atoms:
  - id: bootstrap
    address: world.md
    taxonomy: world
    situations: [fresh]
    purpose: width
    runtime: any
    order: 10
    priority: core
profiles:
  - id: codex-coverage
    situations: [fresh]
    runtimes: [codex]
    phases:
`;
    expect(() => parseManifest(prefix + `
      - { id: first, atoms: [bootstrap] }
      - { id: second, atoms: [bootstrap] }
`, "/world/manifest.yaml")).toThrow(/bootstrap.*出现多次/);
    expect(() => parseManifest(prefix + `
      - { id: first, context: [project] }
      - { id: second, context: [project] }
`, "/world/manifest.yaml")).toThrow(/project.*出现多次/);
  });
});

// Slice-03 血缘修复（R2 终局 HIGH-2）：必须在解析这一摄取瓶颈实施有界、无分隔符的
// 版本谓词（ref-safety.isSafePackVersion），而不能只定义它。含冒号的版本会伪造
// `<name>:<version>` 存储 id；过长版本会突破操作系统文件名长度限制（ENAMETOOLONG）。
// 根据锁定的 PRD，二者都属于构建时修复项，必须在实际解析中拒绝，不能只依赖单元谓词。
describe("parseManifest——实施有界版本谓词（R2 HIGH-2）", () => {
  it("以 manifest_invalid 拒绝含冒号的版本（分隔符伪造向量）", () => {
    expect(() => parseManifest("name: x\nversion: '1:0:0'\nfiles: []", "/x.yaml")).toThrow(ContextPackError);
    try {
      parseManifest("name: x\nversion: '1:0:0'\nfiles: []", "/x.yaml");
    } catch (err) {
      expect((err as ContextPackError).code).toBe("manifest_invalid");
      expect((err as Error).message).toMatch(/version/);
    }
  });

  it("拒绝过长版本（>32 个字符 → ENAMETOOLONG 类）", () => {
    const long = "1" + "a".repeat(300);
    expect(() => parseManifest(`name: x\nversion: '${long}'\nfiles: []`, "/x.yaml")).toThrow(/version/);
  });

  it("仍接受有界且无分隔符的版本（允许点、下划线、加号和连字符）", () => {
    const m = parseManifest("name: x\nversion: '1.2.0-rc.1+build_7'\ntaxonomy: world\nfiles: []", "/x.yaml");
    expect(m.version).toBe("1.2.0-rc.1+build_7");
  });
});
