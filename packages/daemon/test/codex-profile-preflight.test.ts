// OPR.0.3.4.7——Codex profile-v2 预检探针测试。
// 注入 exec，无需真实 Codex。

import { describe, it, expect, vi } from "vitest";
import { verifyCodexProfileLoads } from "../src/domain/codex-profile-preflight.js";
import { verifyCodexProfiles } from "../src/domain/rigspec-preflight.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

describe("verifyCodexProfileLoads", () => {
  it("通过：有效 profile 成功加载", async () => {
    const exec = vi.fn(async () => "");
    const result = await verifyCodexProfileLoads("openrig_pm", exec);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("openrig_pm");
    expect(exec).toHaveBeenCalledWith("codex -p openrig_pm mcp list");
  });

  it("通过：profile 文件缺失（Codex 把缺失 .config.toml 视为有效默认配置分层）", async () => {
    // Advisor 裁决方案 B：Codex 0.139+ 在 profile 文件缺失时退出码为 0（默认配置分层）。
    // 若预检在此失败会形成假阴性：预检拒绝了 launch 实际接受的配置。
    const exec = vi.fn(async () => "");
    const result = await verifyCodexProfileLoads("missing", exec);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("missing");
  });

  it("失败：旧版 [profiles.<name>] 表阻止加载（主要判别条件）", async () => {
    const exec = vi.fn(async () => {
      throw new Error("Error: failed to load configuration: --profile openrig_pm cannot be used while config.toml contains legacy [profiles.openrig_pm] config; move those settings into ~/.codex/openrig_pm.config.toml and remove the legacy selector/table.");
    });
    const result = await verifyCodexProfileLoads("openrig_pm", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("加载失败");
    expect(result.migrationHint).toContain("请将 profile 设置移入");
    expect(result.migrationHint).toContain("openrig_pm.config.toml");
    expect(result.migrationHint).toContain("[profiles.openrig_pm]");
  });

  it("失败：从 execSync 风格错误（err.stderr）捕获 stderr", async () => {
    const exec = vi.fn(async () => {
      const err = new Error("Command failed") as Error & { stderr: string };
      err.stderr = "Error: failed to load configuration: --profile test cannot be used while config.toml contains legacy [profiles.test] config";
      throw err;
    });
    const result = await verifyCodexProfileLoads("test", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("加载失败");
    expect(result.migrationHint).toContain("请将 profile 设置移入");
  });

  it("失败：无效 TOML stderr 不会误分类为旧版迁移（呈现解析原因）", async () => {
    const exec = vi.fn(async () => {
      const err = new Error("Command failed") as Error & { stderr: string };
      err.stderr = "Error: failed to load configuration\nexpected newline, found a period at line 3 column 12\n  in /Users/x/.codex/qa_invalid.config.toml";
      throw err;
    });
    const result = await verifyCodexProfileLoads("qa_invalid", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expected newline");
    expect(result.migrationHint).not.toContain("[profiles.qa_invalid]");
    expect(result.migrationHint).toContain("有效 TOML");
  });

  it("诚实失败：未知错误携带通用提示", async () => {
    const exec = vi.fn(async () => { throw new Error("permission denied"); });
    const result = await verifyCodexProfileLoads("test", exec);
    expect(result.ok).toBe(false);
    expect(result.migrationHint).toContain("手动运行");
  });

  it("失败：探针受超时约束（绝不无限挂起）", async () => {
    const exec = vi.fn(() => new Promise<string>(() => {}));
    const result = await verifyCodexProfileLoads("stuck", exec, 50);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超时");
  });

  it("含特殊字符的 profile 名称会进行 shell quoting", async () => {
    const exec = vi.fn(async () => "");
    await verifyCodexProfileLoads("my profile", exec);
    expect(exec).toHaveBeenCalledWith("codex -p 'my profile' mcp list");
  });
});

describe("verifyCodexProfiles（rigspec 集成）", () => {
  function makeSpec(members: Array<{ id: string; runtime: string; codexConfigProfile?: string }>): PodRigSpec {
    return {
      name: "test-rig",
      version: "0.2",
      pods: [{
        id: "dev",
        label: "Dev",
        members: members.map((m) => ({
          id: m.id,
          runtime: m.runtime,
          agentRef: "local:agents/test",
          cwd: ".",
          codexConfigProfile: m.codexConfigProfile,
        })),
        edges: [],
      }],
      edges: [],
    } as unknown as PodRigSpec;
  }

  it("跳过非 codex member", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "claude-code" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("跳过未配置 profile 的 codex member", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("探测带 profile 的 codex member", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex", codexConfigProfile: "openrig_pm" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).toHaveBeenCalledWith("codex -p openrig_pm mcp list");
  });

  it("对多个 member 使用的同一 profile 去重", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([
        { id: "qa", runtime: "codex", codexConfigProfile: "shared" },
        { id: "ops", runtime: "codex", codexConfigProfile: "shared" },
      ]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("profile 失败时返回错误", async () => {
    const exec = vi.fn(async () => { throw new Error("failed to load configuration"); });
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex", codexConfigProfile: "broken" }]),
      exec,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("dev.impl");
    expect(errors[0]).toContain("broken");
  });
});
