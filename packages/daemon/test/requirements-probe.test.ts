import { describe, it, expect, vi } from "vitest";
import { RequirementsProbeRegistry, type RequirementSpec } from "../src/domain/requirements-probe.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error(`command not found`);
  }) as unknown as ExecFn;
}

describe("RequirementsProbeRegistry", () => {
  // T1：CLI 工具已安装时 status='installed'、detectedPath 有值、version=null。
  it("CLI 工具已安装时返回 installed、detectedPath 和 null version", async () => {
    const exec = createMockExec({ "command -v": "/usr/local/bin/ripgrep" });
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("ripgrep");

    expect(result.status).toBe("installed");
    expect(result.detectedPath).toBe("/usr/local/bin/ripgrep");
    expect(result.version).toBeNull();
    expect(result.kind).toBe("cli_tool");
  });

  // T2：CLI 工具缺失时 status='missing'。
  it("CLI 工具缺失时返回 missing 状态", async () => {
    const exec = createMockExec({});
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("nonexistent-tool");

    expect(result.status).toBe("missing");
    expect(result.detectedPath).toBeNull();
  });

  // T3：Homebrew package 已安装时解析 version，provider='homebrew'。
  it("Homebrew package 已安装时返回 installed 和解析后的 version", async () => {
    const exec = createMockExec({ "brew list --versions": "ripgrep 14.1.0" });
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    const result = await registry.probeBrew("ripgrep");

    expect(result.status).toBe("installed");
    expect(result.version).toBe("14.1.0");
    expect(result.provider).toBe("homebrew");
    expect(result.kind).toBe("system_package");
  });

  // T4：Homebrew package 缺失时 status='missing'、provider='homebrew'。
  it("Homebrew package 缺失时返回 missing 和 homebrew provider", async () => {
    const exec = createMockExec({ "brew list --versions": new Error("Error: No such keg") });
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    const result = await registry.probeBrew("nonexistent-pkg");

    expect(result.status).toBe("missing");
    expect(result.provider).toBe("homebrew");
  });

  // T5：非 darwin 的 system_package 返回 status='unsupported'、command=null，且不调用 exec。
  it("非 darwin system_package 返回 unsupported 和 null command", async () => {
    const exec = vi.fn() as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec, { platform: "linux" });

    const result = await registry.probeRequirement({ name: "libssl", kind: "system_package" });

    expect(result.status).toBe("unsupported");
    expect(result.command).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  // T6：探针超时返回 status='unknown'，error 包含超时信息。
  it("探针超时返回 unknown 和超时错误", async () => {
    const exec: ExecFn = () => new Promise(() => {}); // Never resolves
    const registry = new RequirementsProbeRegistry(exec, { timeoutMs: 50 });

    const result = await registry.probeCli("slow-tool");

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("探测超时");
  });

  // T7：probeAll 按输入顺序返回结果。
  it("probeAll 按输入顺序返回结果", async () => {
    const exec = createMockExec({
      "'git'": "/usr/bin/git",
      "'node'": "/usr/local/bin/node",
      "'missing'": new Error("not found"),
    });
    const registry = new RequirementsProbeRegistry(exec);

    const specs: RequirementSpec[] = [
      { name: "git", kind: "cli_tool" },
      { name: "missing", kind: "cli_tool" },
      { name: "node", kind: "cli_tool" },
    ];

    const results = await registry.probeAll(specs);

    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe("git");
    expect(results[0]!.status).toBe("installed");
    expect(results[1]!.name).toBe("missing");
    expect(results[1]!.status).toBe("missing");
    expect(results[2]!.name).toBe("node");
    expect(results[2]!.status).toBe("installed");
  });

  // T8：command 字段匹配经过 shell 引号处理的精确命令字符串。
  it("探针结果包含经过 shell 引号处理的精确命令", async () => {
    const exec = createMockExec({ "command -v": "/usr/bin/tmux" });
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("tmux");

    expect(result.command).toBe("command -v 'tmux'");
  });

  // T9：所有探针使用 mock ExecFn，并验证预期的 shell 引号命令。
  it("探针通过 mock ExecFn 使用预期的 shell 引号命令", async () => {
    const exec = vi.fn(async () => "/usr/bin/test") as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    await registry.probeCli("my-tool");
    expect(exec).toHaveBeenCalledWith("command -v 'my-tool'");

    await registry.probeBrew("my-pkg");
    expect(exec).toHaveBeenCalledWith("brew list --versions 'my-pkg'");
  });

  // T10：探测指定工具（tmux、claude、codex）时均返回 installed。
  it("探测 tmux、claude、codex 时均返回 installed", async () => {
    const exec = createMockExec({
      "'tmux'": "/usr/local/bin/tmux",
      "'claude'": "/usr/local/bin/claude",
      "'codex'": "/usr/local/bin/codex",
    });
    const registry = new RequirementsProbeRegistry(exec);

    const specs: RequirementSpec[] = [
      { name: "tmux", kind: "cli_tool" },
      { name: "claude", kind: "cli_tool" },
      { name: "codex", kind: "cli_tool" },
    ];

    const results = await registry.probeAll(specs);

    for (const result of results) {
      expect(result.status).toBe("installed");
      expect(result.detectedPath).toBeTruthy();
      expect(result.command).toContain("command -v");
    }
  });

  // T11：name 中含 shell 元字符时，exec 收到经过 shell 引号处理的命令。
  it("安全引用 name 中的 shell 元字符", async () => {
    const exec = vi.fn(async () => { throw new Error("not found"); }) as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec);

    await registry.probeCli("foo; rm -rf /");

    // name 应使用单引号，防止注入。
    expect(exec).toHaveBeenCalledWith("command -v 'foo; rm -rf /'");
  });

  // T12：probeRequirement 将 spec 中的 installHints 原样保留到结果。
  it("probeRequirement 原样保留 spec 中的 installHints", async () => {
    const exec = createMockExec({ "command -v": "/usr/bin/rg" });
    const registry = new RequirementsProbeRegistry(exec);

    const hints = { homebrew: "brew install ripgrep", apt: "apt install ripgrep" };
    const result = await registry.probeRequirement({
      name: "rg",
      kind: "cli_tool",
      installHints: hints,
    });

    expect(result.installHints).toEqual(hints);
    expect(result.status).toBe("installed");
  });

  // T13：EACCES 探针错误返回 unknown 而非 missing——trust 边界修复。
  it("EACCES 探针错误返回 unknown 而非 missing", async () => {
    const exec = vi.fn(async () => { throw new Error("EACCES: permission denied"); }) as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("rg");

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("EACCES");
  });

  // T14：unknown 状态不会经 planner 变成 auto_approvable。
  it("unknown 探针状态在 planner 中映射为 manual_only 而非 auto_approvable", async () => {
    const { ExternalInstallPlanner } = await import("../src/domain/external-install-planner.js");
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const probeResult = {
      name: "rg", kind: "cli_tool" as const, status: "unknown" as const,
      version: null, detectedPath: null, provider: null, command: null,
      installHints: null, error: "EACCES: permission denied",
    };

    const plan = planner.planInstalls([probeResult]);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(0);
  });
});
