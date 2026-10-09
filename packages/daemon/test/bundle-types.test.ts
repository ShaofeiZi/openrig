import { describe, it, expect } from "vitest";
// TODO：AS-T12——迁移到感知 pod 的 bundle 类型。
import {
  validateLegacyBundleManifest as validateBundleManifest,
  parseLegacyBundleManifest as parseBundleManifest,
  normalizeLegacyBundleManifest as normalizeBundleManifest,
  serializeLegacyBundleManifest as serializeBundleManifest,
  isRelativeSafePath,
  type LegacyBundleManifest as BundleManifest,
  type BundleProvenance,
  type BundleCompatibility,
  type BundlePluginReference,
} from "../src/domain/bundle-types.js";

const VALID_RAW = {
  schema_version: 1,
  name: "my-bundle",
  version: "0.1.0",
  created_at: "2026-03-26T00:00:00Z",
  rig_spec: "rig.yaml",
  packages: [
    { name: "review-kit", version: "0.1.0", path: "packages/review-kit", original_source: "github:example/review-kit@v1" },
  ],
  integrity: {
    algorithm: "sha256",
    files: {
      "rig.yaml": "a".repeat(64),
      "packages/review-kit/package.yaml": "b".repeat(64),
    },
  },
};

describe("Bundle 类型", () => {
  // T1：合法 manifest 通过校验
  it("带 integrity 的合法 manifest 可通过校验", () => {
    const result = validateBundleManifest(VALID_RAW);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // T2：校验 package 条目
  it("package 条目必须包含 name、version 和 path", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "", version: "1.0", path: "pkg" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  // T3：校验 integrity 区段
  it("integrity 要求 algorithm=sha256 且 files 非空", () => {
    const raw = { ...VALID_RAW, integrity: { algorithm: "md5", files: {} } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("algorithm"))).toBe(true);
    expect(result.errors.some((e) => e.includes("files"))).toBe(true);
  });

  // T4：拒绝缺少 rig_spec
  it("拒绝缺少 rig_spec 路径的 manifest", () => {
    const raw = { ...VALID_RAW, rig_spec: undefined };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rig_spec"))).toBe(true);
  });

  // T5：拒绝空 packages
  it("拒绝空 packages 数组", () => {
    const raw = { ...VALID_RAW, packages: [] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("packages"))).toBe(true);
  });

  // T6：往返
  it("往返：创建 → 序列化 → 解析 → 校验", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "test-bundle",
      version: "1.0.0",
      createdAt: "2026-03-26T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [
        { name: "pkg-a", version: "1.0.0", path: "packages/pkg-a", originalSource: "local:./pkg-a" },
      ],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "c".repeat(64), "packages/pkg-a/package.yaml": "d".repeat(64) },
      },
    };

    const yaml = serializeBundleManifest(manifest);
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.name).toBe("test-bundle");
    expect(normalized.packages).toHaveLength(1);
    expect(normalized.integrity?.files["rig.yaml"]).toBe("c".repeat(64));
  });

  // T7：拒绝 rig_spec 绝对路径
  it("拒绝 rig_spec 绝对路径", () => {
    const raw = { ...VALID_RAW, rig_spec: "/etc/passwd" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("安全的相对路径"))).toBe(true);
  });

  // T8：拒绝 package 路径中的 ../。
  it("拒绝 package 路径中的目录遍历", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "evil", version: "1.0", path: "../outside", original_source: "" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("安全的相对路径"))).toBe(true);
  });

  // T9：拒绝 integrity 文件 key 中的 ../。
  it("拒绝 integrity 文件 key 中的目录遍历", () => {
    const raw = { ...VALID_RAW, integrity: { algorithm: "sha256", files: { "../etc/passwd": "hash" } } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("安全的相对路径"))).toBe(true);
  });

  // T10：拒绝 ./rig.yaml（点路径段）。
  it("dot segment in rig_spec rejected", () => {
    const raw = { ...VALID_RAW, rig_spec: "./rig.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("安全的相对路径"))).toBe(true);
  });

  // T11：拒绝 packages//review-kit（空路径段）
  it("拒绝 package 路径中的空段", () => {
    const raw = { ...VALID_RAW, packages: [{ name: "pkg", version: "1.0", path: "packages//review-kit", original_source: "" }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("安全的相对路径"))).toBe(true);
  });

  // T12：缺少 provenance 仍合法（向后兼容——第 1 项前的 bundle 可安装）
  it("缺少 provenance 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T13：完整 provenance 块通过校验
  it("full provenance block passes validation", () => {
    const raw = {
      ...VALID_RAW,
      provenance: {
        created_at: "2026-05-18T00:00:00Z",
        source_host: "test-host.local",
        author_session: "velocity-driver@openrig-velocity",
        source_rig_id: "01KQEQPN4MQJN0DHBM5CQ0N8D7",
        source_rig_name: "openrig-velocity",
        daemon_version: "0.3.2",
        cli_version: "0.3.2",
        notes: "Test bundle for Item 1",
      },
    };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T14：部分 provenance（仅 notes）通过校验——所有字段均可选
  it("仅含 notes 的部分 provenance 块可通过校验", () => {
    const raw = { ...VALID_RAW, provenance: { notes: "ad-hoc" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T15：provenance 存在时必须是对象（不能是 null、数组或字符串）
  it("拒绝非对象的 provenance", () => {
    const raw1 = { ...VALID_RAW, provenance: "not-an-object" };
    const result1 = validateBundleManifest(raw1);
    expect(result1.valid).toBe(false);
    expect(result1.errors.some((e) => e.includes("provenance"))).toBe(true);

    const raw2 = { ...VALID_RAW, provenance: [] };
    const result2 = validateBundleManifest(raw2);
    expect(result2.valid).toBe(false);
    expect(result2.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  // T16：拒绝类型错误的 provenance 字段（数字 created_at）
  it("拒绝类型错误的 provenance 字段", () => {
    const raw = { ...VALID_RAW, provenance: { created_at: 12345, source_host: "h" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance.created_at"))).toBe(true);
  });

  // T17：序列化 → 解析 → 归一化往返保留 provenance
  it("序列化、解析、归一化往返会保留 provenance", () => {
    const provenance: BundleProvenance = {
      createdAt: "2026-05-18T12:00:00Z",
      sourceHost: "rt-host",
      authorSession: "velocity-driver@openrig-velocity",
      daemonVersion: "0.3.2",
      cliVersion: "0.3.2",
      notes: "round-trip fixture",
    };
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-bundle",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [
        { name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" },
      ],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "e".repeat(64), "packages/pkg/package.yaml": "f".repeat(64) },
      },
      provenance,
    };

    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("provenance:");
    expect(yaml).toContain("source_host: rt-host");
    expect(yaml).toContain("notes: round-trip fixture");

    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.provenance).toBeDefined();
    expect(normalized.provenance?.sourceHost).toBe("rt-host");
    expect(normalized.provenance?.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(normalized.provenance?.daemonVersion).toBe("0.3.2");
    expect(normalized.provenance?.cliVersion).toBe("0.3.2");
    expect(normalized.provenance?.notes).toBe("round-trip fixture");
  });

  // T18：缺少 provenance 时往返结果为 undefined（YAML 中无该字段）
  it("缺少 provenance 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-prov",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("provenance:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.provenance).toBeUndefined();
  });

  // ——第 2 项 compatibility 块测试（slice-05 Checkpoint 3.1）——

  // C1：缺少 compatibility 仍合法（向后兼容）
  it("缺少 compatibility 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C2：完整 compatibility 块通过校验
  it("full compatibility block passes validation", () => {
    const raw = {
      ...VALID_RAW,
      compatibility: {
        min_daemon_version: "0.3.2",
        min_cli_version: "0.3.2",
        schema_version: 1,
      },
    };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C3：部分 compatibility（仅 min_daemon_version）通过——所有字段均可选
  it("仅含 min_daemon_version 的部分 compatibility 块可通过校验", () => {
    const raw = { ...VALID_RAW, compatibility: { min_daemon_version: "0.3.2" } };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // C4：拒绝存在但非对象的 compatibility
  it("拒绝非对象的 compatibility", () => {
    const raw1 = { ...VALID_RAW, compatibility: "0.3.2" };
    const r1 = validateBundleManifest(raw1);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes("compatibility"))).toBe(true);

    const raw2 = { ...VALID_RAW, compatibility: [] };
    const r2 = validateBundleManifest(raw2);
    expect(r2.valid).toBe(false);
    expect(r2.errors.some((e) => e.includes("compatibility"))).toBe(true);
  });

  // C5：拒绝类型错误的 compatibility 字段
  it("拒绝类型错误的 compatibility 字段", () => {
    const raw1 = { ...VALID_RAW, compatibility: { min_daemon_version: 0.3 } };
    const r1 = validateBundleManifest(raw1);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes("compatibility.min_daemon_version"))).toBe(true);

    const raw2 = { ...VALID_RAW, compatibility: { schema_version: "1" } };
    const r2 = validateBundleManifest(raw2);
    expect(r2.valid).toBe(false);
    expect(r2.errors.some((e) => e.includes("compatibility.schema_version"))).toBe(true);
  });

  // C6：序列化 → 解析 → 归一化往返保留 compatibility
  it("序列化、解析、归一化往返会保留 compatibility", () => {
    const compatibility: BundleCompatibility = {
      minDaemonVersion: "0.3.2",
      minCliVersion: "0.3.2",
      schemaVersion: 1,
    };
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-compat",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "1".repeat(64), "packages/pkg/package.yaml": "2".repeat(64) },
      },
      compatibility,
    };

    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("compatibility:");
    expect(yaml).toContain("min_daemon_version: 0.3.2");

    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.compatibility).toBeDefined();
    expect(normalized.compatibility?.minDaemonVersion).toBe("0.3.2");
    expect(normalized.compatibility?.minCliVersion).toBe("0.3.2");
    expect(normalized.compatibility?.schemaVersion).toBe(1);
  });

  // C7：缺少 compatibility 时可干净往返（YAML 不输出该字段）
  it("缺少 compatibility 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-compat",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("compatibility:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.compatibility).toBeUndefined();
  });

  // ——第 6 项 skills 块测试（slice-05 Checkpoint 7.1）——

  it("缺少 skills 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("由安全相对路径字符串组成的 skills 数组可通过校验", () => {
    const raw = { ...VALID_RAW, skills: ["skills/review-kit/SKILL.md", "skills/test-runner/SKILL.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("拒绝非数组的 skills", () => {
    const raw = { ...VALID_RAW, skills: "skills/a.md" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills 必须是数组"))).toBe(true);
  });

  it("non-string skill entry rejected", () => {
    const raw = { ...VALID_RAW, skills: [123, "skills/ok.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
  });

  it("拒绝不安全的 skill 路径（.. 遍历）", () => {
    const raw = { ...VALID_RAW, skills: ["../escape/skill.md"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不安全"))).toBe(true);
  });

  it("序列化、解析、归一化往返会保留 skills", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-skills",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "9".repeat(64), "packages/pkg/package.yaml": "a".repeat(64) },
      },
      skills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("skills:");
    expect(yaml).toContain("skills/foo/SKILL.md");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.skills).toBeDefined();
    expect(normalized.skills).toEqual(["skills/foo/SKILL.md", "skills/bar/SKILL.md"]);
  });

  it("缺少 skills 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-skills",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("skills:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.skills).toBeUndefined();
  });

  // ——第 6 项 plugins 块测试（slice-05 Checkpoint 7.3b）——

  it("缺少 plugins 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("由合法 {id, source} 条目组成的 plugins 数组可通过校验", () => {
    const raw = {
      ...VALID_RAW,
      plugins: [
        { id: "gstack", source: { kind: "local", path: "plugins/gstack" } },
        { id: "obra-superpowers", source: { kind: "local", path: "plugins/obra-superpowers" } },
      ],
    };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("plugins as non-array rejected", () => {
    const raw = { ...VALID_RAW, plugins: "gstack" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins 必须是数组"))).toBe(true);
  });

  it("拒绝缺少 id 的 plugin 条目", () => {
    const raw = { ...VALID_RAW, plugins: [{ source: { kind: "local", path: "plugins/gstack" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].id"))).toBe(true);
  });

  it("拒绝 source.kind 非 local 的 plugin 条目", () => {
    const raw = { ...VALID_RAW, plugins: [{ id: "x", source: { kind: "remote", path: "plugins/x" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("source.kind 必须为 'local'"))).toBe(true);
  });

  it("拒绝 source.path 不安全的 plugin 条目", () => {
    const raw = { ...VALID_RAW, plugins: [{ id: "x", source: { kind: "local", path: "../escape" } }] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不安全"))).toBe(true);
  });

  it("序列化、解析、归一化往返会保留 plugins", () => {
    const plugins: BundlePluginReference[] = [
      { id: "gstack", source: { kind: "local", path: "plugins/gstack" } },
    ];
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-plugins",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "5".repeat(64), "packages/pkg/package.yaml": "6".repeat(64) },
      },
      plugins,
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("plugins:");
    expect(yaml).toContain("id: gstack");
    expect(yaml).toContain("plugins/gstack");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.plugins).toBeDefined();
    expect(normalized.plugins).toEqual(plugins);
  });

  it("缺少 plugins 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-plugins",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("plugins:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.plugins).toBeUndefined();
  });

  // ——第 6 项 workflow_specs 块测试（slice-05 Checkpoint 7.3e）——

  it("缺少 workflow_specs 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("由安全相对路径字符串组成的 workflow_specs 数组可通过校验", () => {
    const raw = { ...VALID_RAW, workflow_specs: ["workflows/onboarding.yaml", "workflows/release.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("拒绝非数组的 workflow_specs", () => {
    const raw = { ...VALID_RAW, workflow_specs: "workflows/a.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs 必须是数组"))).toBe(true);
  });

  it("non-string workflow_specs entry rejected", () => {
    const raw = { ...VALID_RAW, workflow_specs: [123, "workflows/ok.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]"))).toBe(true);
  });

  it("拒绝不安全的 workflow_specs 路径（.. 遍历）", () => {
    const raw = { ...VALID_RAW, workflow_specs: ["../escape/spec.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不安全"))).toBe(true);
  });

  it("序列化、解析、归一化往返会保留 workflow_specs", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-workflow-specs",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "7".repeat(64), "packages/pkg/package.yaml": "8".repeat(64) },
      },
      workflowSpecs: ["workflows/onboarding.yaml", "workflows/release.yaml"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("workflow_specs:");
    expect(yaml).toContain("workflows/onboarding.yaml");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.workflowSpecs).toBeDefined();
    expect(normalized.workflowSpecs).toEqual(["workflows/onboarding.yaml", "workflows/release.yaml"]);
  });

  it("缺少 workflow_specs 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-workflow-specs",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("workflow_specs:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.workflowSpecs).toBeUndefined();
  });

  // ——第 6 项 context_packs 块测试（slice-05 Checkpoint 7.3f）——

  it("缺少 context_packs 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("由安全相对路径字符串组成的 context_packs 数组可通过校验", () => {
    const raw = { ...VALID_RAW, context_packs: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("拒绝非数组的 context_packs", () => {
    const raw = { ...VALID_RAW, context_packs: "context-packs/intent/manifest.yaml" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs 必须是数组"))).toBe(true);
  });

  it("non-string context_packs entry rejected", () => {
    const raw = { ...VALID_RAW, context_packs: [42, "context-packs/ok/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("必须是字符串"))).toBe(true);
  });

  it("拒绝不安全的 context_packs 路径（.. 遍历）", () => {
    const raw = { ...VALID_RAW, context_packs: ["../escape/manifest.yaml"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不安全"))).toBe(true);
  });

  it("序列化、解析、归一化往返会保留 context_packs", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-context-packs",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "c".repeat(64), "packages/pkg/package.yaml": "d".repeat(64) },
      },
      contextPacks: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("context_packs:");
    expect(yaml).toContain("context-packs/intent/manifest.yaml");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.contextPacks).toBeDefined();
    expect(normalized.contextPacks).toEqual(["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"]);
  });

  it("缺少 context_packs 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-context-packs",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("context_packs:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.contextPacks).toBeUndefined();
  });

  // ——第 6 项 agent_images 块测试（slice-05 Checkpoint 7.3g）——

  it("缺少 agent_images 块仍可通过校验（向后兼容）", () => {
    const raw = { ...VALID_RAW };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("由安全相对路径字符串组成的 agent_images 数组可通过校验", () => {
    const raw = { ...VALID_RAW, agent_images: ["agent-images/seat-a", "agent-images/seat-b"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("拒绝非数组的 agent_images", () => {
    const raw = { ...VALID_RAW, agent_images: "agent-images/x" };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images 必须是数组"))).toBe(true);
  });

  it("non-string agent_images entry rejected", () => {
    const raw = { ...VALID_RAW, agent_images: [99, "agent-images/ok"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("必须是字符串"))).toBe(true);
  });

  it("拒绝不安全的 agent_images 路径（.. 遍历）", () => {
    const raw = { ...VALID_RAW, agent_images: ["../escape"] };
    const result = validateBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("不安全"))).toBe(true);
  });

  it("序列化、解析、归一化往返会保留 agent_images", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "rt-agent-images",
      version: "1.0.0",
      createdAt: "2026-05-18T12:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0.0", path: "packages/pkg", originalSource: "local:./pkg" }],
      integrity: {
        algorithm: "sha256",
        files: { "rig.yaml": "e".repeat(64), "packages/pkg/package.yaml": "f".repeat(64) },
      },
      agentImages: ["agent-images/seat-a", "agent-images/seat-b"],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).toContain("agent_images:");
    expect(yaml).toContain("agent-images/seat-a");
    const parsed = parseBundleManifest(yaml);
    const validation = validateBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.agentImages).toBeDefined();
    expect(normalized.agentImages).toEqual(["agent-images/seat-a", "agent-images/seat-b"]);
  });

  it("缺少 agent_images 时可干净往返（YAML 不输出该字段）", () => {
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: "no-agent-images",
      version: "1.0.0",
      createdAt: "2026-05-18T00:00:00Z",
      rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    const yaml = serializeBundleManifest(manifest);
    expect(yaml).not.toContain("agent_images:");
    const parsed = parseBundleManifest(yaml);
    const normalized = normalizeBundleManifest(parsed);
    expect(normalized.agentImages).toBeUndefined();
  });
});

describe("isRelativeSafePath", () => {
  it("接受简单相对路径，包括名称中带点的路径", () => {
    expect(isRelativeSafePath("rig.yaml")).toBe(true);
    expect(isRelativeSafePath("packages/review-kit/package.yaml")).toBe(true);
    expect(isRelativeSafePath("packages/my-package.v2")).toBe(true);
    expect(isRelativeSafePath("skills/deep..review/SKILL.md")).toBe(true);
  });

  it("拒绝不安全路径", () => {
    expect(isRelativeSafePath("")).toBe(false);
    expect(isRelativeSafePath("/absolute")).toBe(false);
    expect(isRelativeSafePath("../traversal")).toBe(false);
    expect(isRelativeSafePath("foo\\bar")).toBe(false);
    expect(isRelativeSafePath("./dotted")).toBe(false);
    expect(isRelativeSafePath("foo//bar")).toBe(false);
    expect(isRelativeSafePath(".")).toBe(false);
  });
});
