import { describe, it, expect } from "vitest";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";
import type { ProbeResult } from "../src/domain/requirements-probe.js";

function makeProbe(overrides: Partial<ProbeResult> & { name: string; status: ProbeResult["status"] }): ProbeResult {
  return {
    kind: "cli_tool",
    version: null,
    detectedPath: null,
    provider: null,
    command: null,
    installHints: null,
    error: null,
    ...overrides,
  };
}

describe("ExternalInstallPlanner", () => {
  // T1：darwin 上缺少 CLI tool -> auto_approvable，使用 brew install
  it("darwin 上缺少 CLI tool -> auto_approvable，使用 brew install", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.requirementName).toBe("ripgrep");
    expect(action.classification).toBe("auto_approvable");
    expect(action.provider).toBe("homebrew");
    expect(action.commandPreview).toBe("brew install 'ripgrep'");
  });

  // T2：非 darwin 上缺少 CLI tool -> manual_only
  it("非 darwin 上缺少 CLI tool -> manual_only", () => {
    const planner = new ExternalInstallPlanner({ platform: "linux" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.classification).toBe("manual_only");
    expect(action.provider).toBeNull();
    expect(action.commandPreview).toBeNull();
  });

  // T3：已安装 -> 无 action，name 位于 alreadyInstalled
  it("已安装 -> 无 action，name 位于 alreadyInstalled", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "git", status: "installed", detectedPath: "/usr/bin/git" }),
    ]);

    expect(plan.actions).toHaveLength(0);
    expect(plan.alreadyInstalled).toEqual(["git"]);
  });

  // T4：installHints 保留在 action 上，但不用于 commandPreview
  it("installHints 保留在 action 上，但不用于 commandPreview", () => {
    const hints = { homebrew: "brew install ripgrep", apt: "sudo apt install ripgrep" };
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing", installHints: hints }),
    ]);

    const action = plan.actions[0]!;
    expect(action.installHints).toEqual(hints);
    // commandPreview 是可信 provider command，并非来自 hint
    expect(action.commandPreview).toBe("brew install 'ripgrep'");
    expect(action.commandPreview).not.toContain("sudo");
  });

  // T5：多个缺失项 -> 按输入顺序产生多个 action
  it("多个缺失 requirement 按输入顺序产生 action", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
      makeProbe({ name: "jq", status: "installed", detectedPath: "/usr/bin/jq" }),
      makeProbe({ name: "fd", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]!.requirementName).toBe("ripgrep");
    expect(plan.actions[1]!.requirementName).toBe("fd");
    expect(plan.alreadyInstalled).toEqual(["jq"]);
  });

  // T6：commandPreview 使用经 shell quote 的 package name
  it("commandPreview 使用经 shell quote 的 package name", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "my-pkg", status: "missing" }),
    ]);

    expect(plan.actions[0]!.commandPreview).toBe("brew install 'my-pkg'");
  });

  // T7：status='unsupported' → manual_only
  it("probe status 为 unsupported → manual_only", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "libssl", status: "unsupported", kind: "system_package" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.actions[0]!.classification).toBe("manual_only");
    expect(plan.actions[0]!.reason).toContain("没有可信 provider");
  });

  // T8：正确拆分 array
  it("plan 将 action 拆分到 auto/review/manual array", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
      makeProbe({ name: "libssl", status: "unsupported", kind: "system_package" }),
      makeProbe({ name: "git", status: "installed", detectedPath: "/usr/bin/git" }),
    ]);

    expect(plan.autoApprovable).toHaveLength(1);
    expect(plan.autoApprovable[0]!.requirementName).toBe("ripgrep");
    expect(plan.reviewRequired).toHaveLength(0);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.manualOnly[0]!.requirementName).toBe("libssl");
    expect(plan.alreadyInstalled).toEqual(["git"]);
  });

  // T9：status='unknown' -> manual_only（probe 失败）
  it("unknown probe status -> manual_only，并带 probe-failed reason", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "slow-tool", status: "unknown", error: "probe timed out" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.classification).toBe("manual_only");
    expect(action.reason).toContain("probe 失败");
    expect(action.commandPreview).toBeNull();
  });

  // T10：darwin 上缺少 system_package -> auto_approvable，使用 brew install
  it("darwin 上缺少 system_package -> auto_approvable，使用 brew install", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "openssl", status: "missing", kind: "system_package" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.requirementName).toBe("openssl");
    expect(action.kind).toBe("system_package");
    expect(action.classification).toBe("auto_approvable");
    expect(action.provider).toBe("homebrew");
    expect(action.commandPreview).toBe("brew install 'openssl'");
  });
});
