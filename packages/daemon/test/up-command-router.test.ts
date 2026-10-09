import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UpCommandRouter } from "../src/domain/up-command-router.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

const BUNDLE_MANIFEST = `
schema_version: 1
name: my-bundle
version: "0.1.0"
created_at: "2026-01-01T00:00:00Z"
rig_spec: rig.yaml
packages:
  - name: pkg
    version: "1.0"
    path: packages/pkg
    original_source: local:./pkg
integrity:
  algorithm: sha256
  files:
    rig.yaml: ${"a".repeat(64)}
`.trim();

const PKG_MANIFEST = `
schema_version: 1
name: my-pkg
version: "1.0.0"
summary: A package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
`.trim();

function realFsOps() {
  return {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, bytes: number) => {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, 0);
      fs.closeSync(fd);
      return buf;
    },
  };
}

describe("UpCommandRouter 路由", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-router-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T1：.yaml -> rig_spec
  it("将 .yaml 文件路由为 rig_spec", () => {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(specPath);

    expect(result.sourceKind).toBe("rig_spec");
    expect(result.sourceRef).toBe(specPath);
  });

  // T2：.rigbundle -> rig_bundle
  it("将 .rigbundle 文件路由为 rig_bundle", () => {
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    // 写入最小有效 gzip 文件
    fs.writeFileSync(bundlePath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(bundlePath);

    expect(result.sourceKind).toBe("rig_bundle");
  });

  // T3：未知扩展名 -> 错误
  it("未知扩展名抛出可操作的错误信息", () => {
    const txtPath = path.join(tmpDir, "readme.txt");
    fs.writeFileSync(txtPath, "just text");
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(txtPath)).toThrow(/不是有效的工作组 spec|无法确定/);
  });

  // T4：文件缺失 -> 错误
  it("文件缺失时抛错", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route("/nonexistent/file.yaml")).toThrow(/未找到 source/);
  });

  // T5a：无扩展名的有效 rig spec -> rig_spec
  it("自动将无扩展名的有效工作组 spec 检测为 rig_spec", () => {
    const noExtPath = path.join(tmpDir, "myrig");
    fs.writeFileSync(noExtPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(noExtPath);

    expect(result.sourceKind).toBe("rig_spec");
  });

  // T5b：无扩展名 gzip -> rig_bundle
  it("自动将无扩展名 gzip 文件检测为 rig_bundle", () => {
    const noExtPath = path.join(tmpDir, "mybundle");
    fs.writeFileSync(noExtPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(noExtPath);

    expect(result.sourceKind).toBe("rig_bundle");
  });

  // T5c：扩展名为 .yaml 的 bundle.yaml -> 可操作的错误
  it("通过 .yaml 扩展名路由 bundle.yaml 时给出可操作的错误", () => {
    const bundleYaml = path.join(tmpDir, "bundle.yaml");
    fs.writeFileSync(bundleYaml, BUNDLE_MANIFEST);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(bundleYaml)).toThrow(/bundle manifest/i);
    expect(() => router.route(bundleYaml)).toThrow(/zrig bundle install/i);
  });

  // T5d：扩展名为 .yaml 的 package.yaml -> 可操作的错误
  it("通过 .yaml 扩展名路由 package.yaml 时给出可操作的错误", () => {
    const pkgYaml = path.join(tmpDir, "package.yaml");
    fs.writeFileSync(pkgYaml, PKG_MANIFEST);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(pkgYaml)).toThrow(/package manifest/i);
    expect(() => router.route(pkgYaml)).toThrow(/zrig package install/i);
  });

  // T6：返回正确类型
  it("返回 shape 正确的 RouteResult", () => {
    const specPath = path.join(tmpDir, "spec.yml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    const result = router.route(specPath);

    expect(result).toHaveProperty("sourceKind");
    expect(result).toHaveProperty("sourceRef");
    expect(["rig_spec", "rig_bundle"]).toContain(result.sourceKind);
  });

  // AS-T08b：接受双格式——接受 pod-aware rig spec
  it("将 pod-aware 工作组 spec 路由为 rig_spec", () => {
    const podSpec = `
version: "0.2"
name: pod-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-rig.yaml");
    fs.writeFileSync(specPath, podSpec);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  it("让无效 pod-shaped spec 保留 pod validator 的精确 diagnostic", () => {
    const podSpecWithTypo = `
version: "0.2"
name: pod-rig
operating_mod: lab
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-rig-typo.yaml");
    fs.writeFileSync(specPath, podSpecWithTypo);
    const router = new UpCommandRouter({ fsOps: realFsOps() });

    expect(() => router.route(specPath)).toThrow(
      'operating_mod：未知键 "operating_mod"；拒绝该规范，因为规范化会丢弃此键并改变请求的拓扑',
    );
  });

  it.each(["typo-root.yaml", "typo-root"])(
    "让拼错的 pod root %s 留在 pod validator 处理",
    (filename) => {
      const podSpecWithMisspelledRoot = `
version: "0.2"
name: typo-root
podz:
  - id: ops
    label: Ops
    members: []
    edges: []
edges: []
`.trim();
      const specPath = path.join(tmpDir, filename);
      fs.writeFileSync(specPath, podSpecWithMisspelledRoot);
      const router = new UpCommandRouter({ fsOps: realFsOps() });

      expect(() => router.route(specPath)).toThrow(
        'podz：未知键 "podz"；拒绝该规范，因为规范化会丢弃此键并改变请求的拓扑',
      );
      expect(() => router.route(specPath)).not.toThrow(/nodes is required/);
    },
  );

  // AS-T08b：仍接受 legacy rig spec
  it("仍将 legacy 工作组 spec 路由为 rig_spec", () => {
    const specPath = path.join(tmpDir, "legacy.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  // NS-T06：rig name 检测
  it("不含 / 与扩展名的裸名称 → rig_name", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route("auth-feats");
    expect(result.sourceKind).toBe("rig_name");
    expect(result.sourceRef).toBe("auth-feats");
  });

  it("带 .yaml 扩展名的名称 → 不是 rig_name（而是文件路径）", () => {
    const specPath = path.join(tmpDir, "auth.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    const result = router.route(specPath);
    expect(result.sourceKind).toBe("rig_spec");
  });

  it("含 / 的路径 → 不是 rig_name", () => {
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(() => router.route("/tmp/nonexistent")).toThrow(/未找到 source/);
  });

  // ── OPR.0.4.4.11——topology 分类（guard G-1 枚举集）────────────────────────────
  // FR-1 detection contract：`.rigtopology` 扩展名，或带顶层 `rigs:` LIST 的 YAML document。
  // 扩展名优先于 sniff；不含斜杠且无扩展名的 source 逐字保留 rig_name 优先级（FR-2）。

  const TOPOLOGY_YAML = "rigs:\n  - source: ./orch.yaml\n  - source: ./workers/rig.yaml\n    host: vps-b\nconcurrency: 2\n";

  it("G1-1：不含斜杠的裸 factory.rigtopology → topology（扩展名优先于名称检测）", () => {
    // stub fs：裸 ref 相对于 daemon cwd 解析；存在性是扩展名分支唯一需要的 fs fact。
    const router = new UpCommandRouter({
      fsOps: { exists: () => true, readFile: () => TOPOLOGY_YAML, readHead: () => Buffer.alloc(0) },
    });
    const result = router.route("factory.rigtopology");
    expect(result).toEqual({ sourceKind: "topology", sourceRef: "factory.rigtopology" });
  });

  it("G1-2：./factory.rigtopology 路径形式 → topology", () => {
    const p = path.join(tmpDir, "factory.rigtopology");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-3：manifest 内容无效的 .rigtopology 仍分类为 topology（声明 kind 具有约束力，不落入 rig-spec）", () => {
    const p = path.join(tmpDir, "broken.rigtopology");
    fs.writeFileSync(p, VALID_SPEC); // topology 扩展名下的 rig-spec 内容
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-4：含斜杠、无扩展名且有顶层 rigs 的文件 → topology（autoDetect sniff）", () => {
    const p = path.join(tmpDir, "mytopo");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-5：不含斜杠且无扩展名的 source 保留 rig_name 优先级——即使存在同名文件也不查询 fs", () => {
    const boom = () => {
      throw new Error("fs must not be touched for a no-slash extensionless source");
    };
    const router = new UpCommandRouter({ fsOps: { exists: boom, readFile: boom, readHead: boom } });
    const result = router.route("factory"); // ./factory 是显式 path escape hatch
    expect(result.sourceKind).toBe("rig_name");
  });

  it("G1-6：带顶层 rigs: list 的 factory.yaml → topology（在 rig-spec validation 前 sniff）", () => {
    const p = path.join(tmpDir, "factory.yaml");
    fs.writeFileSync(p, TOPOLOGY_YAML);
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-7：同时带 rigs: list 与 edge/routing key 的 YAML 仍分类为 topology（由下游 TOPOLOGY validation 拒绝，而非 rig-spec error）", () => {
    const p = path.join(tmpDir, "edgy.yaml");
    fs.writeFileSync(p, TOPOLOGY_YAML + "edges:\n  - from: a\n    to: b\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(router.route(p).sourceKind).toBe("topology");
  });

  it("G1-8：无 rigs 的无效 YAML 保留现有 rig-spec error surface", () => {
    const p = path.join(tmpDir, "invalid.yaml");
    fs.writeFileSync(p, "just: nonsense\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    expect(() => router.route(p)).toThrow(/Source 是 YAML，但不是有效的工作组 spec/);
  });

  it("G1-9：非 list 的 rigs: 不会 sniff 为 topology——进入现有 YAML 处理", () => {
    const p = path.join(tmpDir, "rigsmap.yaml");
    fs.writeFileSync(p, "rigs:\n  a: 1\n");
    const router = new UpCommandRouter({ fsOps: realFsOps() });
    // 按契约不是 topology（必须为 list；.rigtopology 是 escape hatch）——error 由现有 rig-spec
    // validation 负责。
    expect(() => router.route(p)).toThrow(/不是有效的工作组 spec/);
  });
});
