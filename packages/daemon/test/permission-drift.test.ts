import { describe, expect, it } from "vitest";
import {
  diagnoseRuntimePosture,
  observeClaudePermission,
  observeCodexSandbox,
  observePiResourceTrust,
  parseClaudePermissionModes,
  renderPermissionDriftSummary,
  type PermissionDriftFs,
} from "../src/domain/permission-drift.js";

function fsFixture(files: Record<string, string | Error>, cwdReadable: boolean | null = true): PermissionDriftFs {
  return {
    readFile(path) {
      const value = files[path];
      if (value === undefined) {
        const err = new Error(`missing: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (value instanceof Error) throw value;
      return value;
    },
    cwdReadable: () => cwdReadable,
    commandAvailable: () => true,
    claudePermissionModes: () => ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  };
}

const cwd = "/tmp/w3-project";
const settingsPath = `${cwd}/.claude/settings.local.json`;

describe("已应用 launch observation 保留所发出的 argument value", () => {
  it("保留 Claude permission vocabulary", () => {
    expect(observeClaudePermission("--permission-mode acceptEdits")).toEqual({
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "acceptEdits",
      reason: "emitted_launch_arguments",
    });
    expect(observeClaudePermission("--dangerously-skip-permissions").value).toBe("bypassPermissions");
  });

  it("保留 Codex sandbox vocabulary，并拒绝猜测 named-profile semantics", () => {
    expect(observeCodexSandbox(" -s workspace-write")).toMatchObject({ axis: "sandbox", state: "observed", value: "workspace-write" });
    expect(observeCodexSandbox(" -s danger-full-access")).toMatchObject({ axis: "sandbox", state: "observed", value: "danger-full-access" });
    expect(observeCodexSandbox(" -p cautious")).toMatchObject({ axis: "sandbox", state: "unknown", value: null, reason: "named_profile_unresolved" });
  });

  it("保留 Pi resource-trust vocabulary，绝不称其为 permission", () => {
    const observation = observePiResourceTrust("approve");
    expect(observation).toEqual({ runtime: "pi", axis: "resource_trust", state: "observed", value: "approve" });
    expect(JSON.stringify(observation)).not.toMatch(/permission/i);
  });
});

describe("只读 configuration comparison 与未知 native enforcement", () => {
  it("从 live help shape 派生 Claude permission vocabulary", () => {
    expect(parseClaudePermissionModes([
      "--permission-mode <mode>  Permission mode to use",
      "  (choices: \"acceptEdits\", \"auto\", \"bypassPermissions\",",
      "  \"manual\", \"dontAsk\", \"plan\")",
    ].join("\n"))).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
    expect(parseClaudePermissionModes("no permission surface")).toBeNull();
  });

  it("将收窄的 Claude project policy 报告为 drift，并给出精确文件与独立 axis", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({
        [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual", allow: ["Read(.)"], deny: ["Read(/tmp/**)"] } }),
      }),
    });

    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe("visible");
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.configuration).toMatchObject({
      comparison: "drift",
      expected: "acceptEdits",
      sourcePath: settingsPath,
    });
    expect(diagnostic.configuration?.observed).toEqual({
      defaultMode: "manual",
      allow: ["Read(.)"],
      ask: [],
      deny: ["Read(/tmp/**)"],
    });
  });

  it("将匹配的 Claude defaultMode 报告为 aligned", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "aligned", expected: "acceptEdits" });
    expect(diagnostic.enforcement).toMatchObject({ state: "unknown", effective: null });
  });

  it("将 bypass argument 与观测到的 project setting 分开", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--dangerously-skip-permissions"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual", deny: ["Read(/**)"] } }) }),
    });
    expect(diagnostic.enforcement).toMatchObject({
      axis: "permission",
      state: "unknown",
      expected: "bypassPermissions",
      effective: null,
      sourcePath: null,
      reason: "native_permission_effect_unverified",
    });
  });

  it("不让普通 acceptEdits 绕过收窄的 project policy", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual" } }) }),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "drift", expected: "acceptEdits" });
    expect(diagnostic.enforcement.state).toBe("unknown");
  });

  it("无法解析 live harness semantics 时报告 UNKNOWN-EFFECTIVE", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
        claudePermissionModes: () => null,
      },
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason: "harness_semantics_unknown" });
  });

  it.each([
    ["missing", {}, "settings_missing"],
    ["malformed", { [settingsPath]: "{" }, "settings_unparseable"],
    ["top-level array", { [settingsPath]: "[]" }, "settings_invalid_shape"],
    ["scalar permissions", { [settingsPath]: JSON.stringify({ permissions: "denyAll" }) }, "permissions_invalid_shape"],
    ["unsupported mode", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "futureMode" } }) }, "unsupported_default_mode"],
    ["conflicting rule", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits", allow: ["Read(/**)"], deny: ["Read(/**)"] } }) }, "conflicting_rules"],
  ])("keeps %s UNKNOWN-EFFECTIVE", (_name, files, reason) => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture(files as Record<string, string>),
    });
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason, sourcePath: settingsPath });
  });

  it.each([
    ["cwd/read", false, true, "denied", "available"],
    ["command/PATH", true, false, "visible", "missing"],
  ] as const)("isolates the %s axis while every other local axis stays healthy", (_axis, cwdVisible, commandPresent, cwdState, commandState) => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }, cwdVisible),
        commandAvailable: () => commandPresent,
      },
    });
    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe(cwdState);
    expect(diagnostic.commandPath.state).toBe(commandState);
    expect(diagnostic.enforcement.state).toBe("unknown");
    expect(diagnostic.configuration?.comparison).toBe("aligned");
  });

  it("将不可读 setting 与健康的 transport、cwd、command axis 分开", () => {
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: denied }, true),
        commandAvailable: () => true,
      },
    });
    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe("visible");
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.configuration).toMatchObject({ comparison: "unknown", reason: "settings_unreadable" });
  });

  it("不在 permissions 列中渲染 Pi resource trust", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "pi",
      cwd,
      applied: observePiResourceTrust("no-approve"),
      fs: fsFixture({}),
    });
    const text = renderPermissionDriftSummary(diagnostic);
    expect(text).toContain("资源信任");
    expect(text).not.toMatch(/permission(?:s)?\s*:/i);
  });
});
