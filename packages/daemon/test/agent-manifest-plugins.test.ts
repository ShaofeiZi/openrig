// plugin-primitive 阶段 3a 切片 3.1 的测试套件——验证 agent manifest 对
// resources.plugins[] + profile.uses.plugins[] 的支持，并根据 redo-guard-2
// 结论显式拒绝旧版 resources.hooks + profile.uses.hooks（2026-05-10 的
// 阻断性关注点：静默丢弃而不拒绝并不构成充分的向后兼容；旧字段必须产生
// 清晰错误，以便作者更新）。

import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

describe("AgentSpec 插件支持——校验器与规范化器", () => {
  // ============================================================
  // 类别 1——拒绝旧版 HOOKS 字段（依据 redo-guard-2 #1）
  // ============================================================

  it("以清晰的迁移错误拒绝旧版 resources.hooks", () => {
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
resources:
  hooks:
    - id: old-hook
      path: hooks/old.yaml
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("resources.hooks") && e.includes("移除"))).toBe(true);
  });

  it("以清晰的迁移错误拒绝旧版 profile.uses.hooks", () => {
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
profiles:
  default:
    uses:
      hooks: [old-hook]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("profiles.default.uses.hooks") && e.includes("移除"))).toBe(true);
  });

  it("拒绝旧版 hooks 的错误将 plugins 指明为迁移目标", () => {
    // 错误消息应将操作者指向新字段，使其无需阅读文档也能明确迁移路径。
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
resources:
  hooks: []
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    const hookErr = result.errors.find((e) => e.includes("resources.hooks"));
    expect(hookErr).toBeDefined();
    expect(hookErr).toMatch(/plugins/);
  });

  // ============================================================
  // 类别 2——接受并规范化插件资源（依据 redo-guard-2 #2）
  // ============================================================

  it("接受包含 id、source.kind=local 和 source.path 的 resources.plugins", () => {
    const raw = parseAgentSpec(`
name: pluginned
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);

    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins).toHaveLength(1);
    expect(spec.resources.plugins[0]!.id).toBe("openrig-core");
    expect(spec.resources.plugins[0]!.source.kind).toBe("local");
    expect(spec.resources.plugins[0]!.source.path).toBe("~/.openrig/plugins/openrig-core");
  });

  it("接受 plugin_type 字段（claude/codex/auto）", () => {
    const raw = parseAgentSpec(`
name: pluginned
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source: { kind: local, path: /abs/plugins/openrig-core }
      plugin_type: auto
    - id: superpowers
      source: { kind: local, path: /abs/plugins/superpowers }
      plugin_type: claude
    - id: codex-special
      source: { kind: local, path: /abs/plugins/codex-special }
      plugin_type: codex
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins[0]!.pluginType).toBe("auto");
    expect(spec.resources.plugins[1]!.pluginType).toBe("claude");
    expect(spec.resources.plugins[2]!.pluginType).toBe("codex");
  });

  it("拒绝缺少 id 的插件条目", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ source: { kind: "local", path: "/p" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].id"))).toBe(true);
  });

  it("拒绝缺少 source 的插件条目", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p" }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source"))).toBe(true);
  });

  it("拒绝 source.kind 不受支持的插件条目（v0 仅支持 local）", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "git", url: "github:foo/bar" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("source.kind") && e.includes("local"))).toBe(true);
  });

  it("拒绝 source.path 为空的插件条目", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "local", path: "" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path"))).toBe(true);
  });

  it("拒绝重复的插件 id", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: dup
      source: { kind: local, path: /a }
    - id: dup
      source: { kind: local, path: /b }
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ID") && e.includes("dup") && e.includes("重复"))).toBe(true);
  });

  it("拒绝无效的 plugin_type 值", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "local", path: "/p" }, plugin_type: "gemini" }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugin_type"))).toBe(true);
  });

  it("插件 source.path 可以是绝对路径（由操作者管理插件位置）", () => {
    // 插件位于规范目录之外（随附在 ~/.openrig/plugins/<id>/，或由操作者安装在
    // 其他位置）。技能路径出于安全考虑必须相对于规范，而插件源路径则明确允许
    // 使用绝对路径。
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: vendored
      source: { kind: local, path: /Users/op/.openrig/plugins/openrig-core }
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
  });

  // ============================================================
  // 类别 3——解析 PROFILE USES.PLUGINS（依据 redo-guard-2 #3）
  // ============================================================

  it("根据已声明的插件池解析 profile.uses.plugins 引用", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source: { kind: local, path: /p/openrig-core }
profiles:
  default:
    uses:
      plugins: [openrig-core]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("未限定的 profile.uses.plugins 引用未声明插件时失败", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
profiles:
  default:
    uses:
      plugins: [missing-plugin]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins") && e.includes("missing-plugin"))).toBe(true);
  });

  it("未声明插件时 normalize 生成空 plugins[]", () => {
    const raw = parseAgentSpec(`
name: minimal
version: "0.2"
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins).toEqual([]);
  });

  it("profile 未声明插件时 normalize 生成空 profile.uses.plugins[]", () => {
    const raw = parseAgentSpec(`
name: minimal-profile
version: "0.2"
profiles:
  default:
    uses:
      skills: []
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.profiles["default"]!.uses.plugins).toEqual([]);
  });
});
