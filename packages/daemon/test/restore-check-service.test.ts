import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RestoreCheckService,
  type RestoreCheckDeps,
  type NodeInventoryEntry,
  // OPR.0.3.2.14——这些内容过去被复制粘贴到 7 个以上测试文件中；现已从源码导出，
  // 使未来的清理/重构只需修改一处。参见 restore-check-service.ts 第 204—224 行。
  CLAUDE_HOOKS_ROOT,
  CLAUDE_SESSION_START_COMPACT_COMMAND as REQUIRED_SESSION_START_COMPACT_COMMAND,
  CLAUDE_USER_PROMPT_SUBMIT_COMMAND as REQUIRED_USER_PROMPT_SUBMIT_COMMAND,
} from "../src/domain/restore-check-service.js";

const VALID_HOST_INFRA_DECLARATION = JSON.stringify({
  schemaVersion: 1,
  daemonBootstrap: {
    declared: true,
    mechanism: "launchd",
    evidence: "com.openrig.daemon",
  },
  supportingInfra: [
    {
      id: "supervisor-wake",
      declared: true,
      required: true,
      evidence: "kernel rig infra seat or host launch agent",
    },
  ],
});

function v2HostInfraDeclaration(overrides?: {
  daemonEvidencePaths?: string[];
  supportingInfra?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    daemonBootstrap: {
      declared: true,
      mechanism: "launchd",
      evidence: "com.openrig.daemon",
      evidencePaths: overrides?.daemonEvidencePaths,
    },
    supportingInfra: overrides?.supportingInfra ?? [
      {
        id: "supervisor-wake",
        declared: true,
        required: true,
        evidence: "kernel rig infra seat or host launch agent",
        evidencePaths: ["${OPENRIG_HOME}/supervisor-wake/README.md"],
      },
    ],
  });
}

function claudeSettings(options?: {
  sessionStartCommand?: string | null;
  sessionStartMatcher?: string;
  userPromptSubmitCommand?: string | null;
  wrongEventCommand?: string | null;
}): string {
  const sessionStartHooks = [];
  if (options?.sessionStartCommand !== null) {
    sessionStartHooks.push({
      type: "command",
      command: options?.sessionStartCommand ?? REQUIRED_SESSION_START_COMPACT_COMMAND,
    });
  }

  const userPromptSubmitHooks = [];
  if (options?.userPromptSubmitCommand !== null) {
    userPromptSubmitHooks.push({
      type: "command",
      command: options?.userPromptSubmitCommand ?? REQUIRED_USER_PROMPT_SUBMIT_COMMAND,
    });
  }

  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: options?.sessionStartMatcher ?? "compact",
          hooks: sessionStartHooks,
        },
        ...(options?.wrongEventCommand
          ? [{
              matcher: "wrong-event",
              hooks: [{ type: "command", command: options.wrongEventCommand }],
            }]
          : []),
      ],
      UserPromptSubmit: [
        {
          hooks: userPromptSubmitHooks,
        },
      ],
    },
  });
}

function claudeNode(overrides?: Partial<NodeInventoryEntry> & { cwd?: string | null }): NodeInventoryEntry {
  return {
    nodeId: "node-1",
    rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
    podId: "dev", podNamespace: "dev",
    canonicalSessionName: "dev-impl@test-rig",
    nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready",
    tmuxAttachCommand: "tmux attach -t dev-impl@test-rig",
    latestError: null,
    ...overrides,
  } as NodeInventoryEntry;
}

function startupContextProbe(options?: {
  status?: "ok" | "missing" | "malformed" | "probe_error";
  evidence?: string;
  resolvedStartupFiles?: Array<{ absolutePath: string; required: boolean; path?: string; deliveryHint?: string }>;
  projectionEntries?: Array<{ absolutePath: string; effectiveId?: string; category?: string }>;
  runtime?: string;
}) {
  if (options?.status && options.status !== "ok") {
    return {
      status: options.status,
      evidence: options.evidence ?? "startup context unavailable",
    };
  }

  return {
    status: "ok",
    runtime: options?.runtime ?? "claude-code",
    resolvedStartupFiles: options?.resolvedStartupFiles ?? [],
    projectionEntries: options?.projectionEntries ?? [],
  };
}

function settingsDeps(input: {
  settings: Record<string, string>;
  nodes?: NodeInventoryEntry[];
  hostInfraDeclared?: boolean;
}): { deps: RestoreCheckDeps; readPaths: string[] } {
  const readPaths: string[] = [];
  const settingsPaths = new Set(Object.keys(input.settings));
  return {
    readPaths,
    deps: mockDeps({
      getNodeInventory: () => input.nodes ?? [claudeNode()],
      exists: (p) => {
        if (p.endsWith("host-infra.json")) return input.hostInfraDeclared ?? true;
        if (p.includes(`${path.sep}.claude${path.sep}settings`)) return settingsPaths.has(p);
        return true;
      },
      readFile: (p) => {
        readPaths.push(p);
        if (p.endsWith("host-infra.json")) return VALID_HOST_INFRA_DECLARATION;
        const value = input.settings[p];
        if (value === undefined) throw new Error(`unexpected read: ${p}`);
        return value;
      },
    }),
  };
}

function mockDeps(overrides?: Partial<RestoreCheckDeps & {
  getStartupContext: (nodeId: string) => unknown;
}>): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => [
      {
        nodeId: "node-1",
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig",
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: "tmux attach -t dev-impl@test-rig",
        latestError: null,
      } as NodeInventoryEntry,
    ],
    hasSnapshot: () => true,
    getLatestSnapshot: () => null,
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running on port 7433" }),
    exists: () => true,
    readFile: () => VALID_HOST_INFRA_DECLARATION,
    getStartupContext: () => startupContextProbe(),
    ...overrides,
  };
}

describe("RestoreCheckService", () => {
  let previousOpenRigHome: string | undefined;
  let testOpenRigHome: string | null;

  beforeEach(() => {
    previousOpenRigHome = process.env["OPENRIG_HOME"];
    testOpenRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-openrig-home-"));
    process.env["OPENRIG_HOME"] = testOpenRigHome;
  });

  afterEach(() => {
    if (previousOpenRigHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = previousOpenRigHome;
    if (testOpenRigHome) fs.rmSync(testOpenRigHome, { recursive: true, force: true });
    testOpenRigHome = null;
  });

  // --- 后台服务假绿回归矩阵 ---

  it("后台服务停止：精确的 'Daemon not running' 文本产生 red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running — start it with: rig daemon start" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("后台服务停止：小写 'daemon not running' 文本产生 red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "daemon not running" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("后台服务停止：空输出产生 red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("后台服务停止：包含非锚定 'running' 的可疑文本产生 red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: true, evidence: "Something is running but not the daemon" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("后台服务运行：规范且锚定的 'Daemon running' 产生 green", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running on port 7433" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("green");
  });

  // --- 探测错误 → unknown（而非 not_restorable）---

  it("probeDaemonHealth 抛出异常时判定为 unknown（而非 not_restorable）", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
    expect(daemon?.evidence).toContain("无法确定状态");
  });

  it("listRigs 探测错误产生 unknown 判定（而非 not_restorable）", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => { throw new Error("database locked"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
    const probe = result.checks.find((c) => c.check === "probe.error");
    expect(probe?.status).toBe("red");
    expect(probe?.evidence).toContain("database locked");
  });

  it("getNodeInventory 探测错误产生 unknown 判定", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => { throw new Error("query timeout"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
  });

  // --- 只读不变量 ---

  it("状态目录检查不创建探测文件，也不修改目录 mtime（只读）", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-readonly-"));
    const probePath = path.join(tmpDir, ".restore-check-probe");
    const previous = process.env["OPENRIG_HOME"];

    // 将 mtime 固定为已知的过去值，以便检测任何变更。
    fs.utimesSync(tmpDir, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(tmpDir).mtimeMs;

    process.env["OPENRIG_HOME"] = tmpDir;
    try {
      const service = new RestoreCheckService(mockDeps());
      const result = service.check({ noQueue: true, noHooks: true });

      // 未创建探测文件。
      expect(fs.existsSync(probePath)).toBe(false);
      // 目录 mtime 不变——未修改文件系统。
      expect(fs.statSync(tmpDir).mtimeMs).toBe(before);
      // 检查本身已运行并产生结果。
      const stateDir = result.checks.find((c) => c.check === "host.state-dir-writable");
      expect(stateDir).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- 主机基础设施声明 ---

  it("缺少主机基础设施声明是非阻塞注意项，并阻止 ready", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-missing-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p === declarationPath ? fs.existsSync(p) : true,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check).toEqual(expect.objectContaining({
        status: "yellow",
      }));
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.remediation).toContain(declarationPath);
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.hostInfra.evidence).toContain(declarationPath);
      expect(result.verdict).toBe("restorable_with_caveats");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.repairPacket).toEqual([
        expect.objectContaining({
          command: expect.stringContaining(declarationPath),
          safe: false,
          blocking: false,
        }),
      ]);
      expect(fs.existsSync(declarationPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("未知工作组在 not_restorable 结果中保留主机基础设施声明缺失状态", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-missing-rig-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p === declarationPath ? fs.existsSync(p) : true,
      }));
      const result = service.check({ rig: "missing-rig", noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("not_restorable");
      expect(check).toEqual(expect.objectContaining({
        status: "yellow",
        evidence: expect.stringContaining(declarationPath),
      }));
      expect(result.hostInfra).toEqual(expect.objectContaining({
        status: "not_declared",
        evidence: check?.evidence,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("未知工作组在 not_restorable 结果中保留已声明的主机基础设施状态", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-declared-rig-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ rig: "missing-rig", noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("not_restorable");
      expect(check).toEqual(expect.objectContaining({
        status: "green",
        evidence: expect.stringContaining(declarationPath),
      }));
      expect(result.hostInfra).toEqual(expect.objectContaining({
        status: "declared",
        evidence: check?.evidence,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("格式错误的主机基础设施声明为 yellow，并包含精确路径和解析错误", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-malformed-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => p === declarationPath ? "{ bad json" : VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toMatch(/parse|JSON/i);
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(declarationPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("不把任意 JSON 接受为已声明的主机基础设施契约", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-invalid-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => p === declarationPath ? JSON.stringify({ arbitrary: true }) : VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("schemaVersion");
      expect(check?.evidence).toContain("daemonBootstrap.mechanism");
      expect(check?.evidence).toContain("supportingInfra");
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("有效主机基础设施声明产生 green 的“已声明但未验证”证据", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-valid-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("已声明主机基础设施");
      expect(check?.evidence).toContain("尚未验证");
      expect(check?.evidence).toContain("mechanism=launchd");
      expect(check?.evidence).toContain("requiredSupportingInfra=1");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain("已声明主机基础设施");
      expect(result.hostInfra.evidence).toContain("尚未验证");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
      expect(result.readiness.reason).toBe("all_observable_checks_green_host_infra_declared_not_verified");
      expect(result.repairPacket).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 的全部证据路径存在时为 green，且不夸大自动启动能力", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-present-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: [daemonPath],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain("evidence path 已存在");
      expect(check?.evidence).toContain("尚未验证自动启动");
      expect(check?.evidence).toContain(daemonPath);
      expect(check?.evidence).toContain(supportPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain("尚未验证自动启动");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
      expect(result.repairPacket).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 要求 daemonBootstrap evidencePaths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-no-daemon-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration(),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("daemonBootstrap.evidencePaths");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining("daemonBootstrap.evidencePaths"),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 缺少后台服务证据路径时为 yellow，并包含精确路径", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-missing-daemon-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p !== daemonPath,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(daemonPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain(daemonPath);
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(daemonPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 缺少必需的辅助证据路径时为 yellow，并包含精确路径", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-missing-support-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p !== supportPath,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(supportPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(supportPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 的必需 supportingInfra 没有 evidencePaths 时证据不足", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-required-no-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [{
            id: "supervisor-wake",
            declared: true,
            required: true,
            evidence: "kernel rig infra seat or host launch agent",
          }],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("supportingInfra[supervisor-wake].evidencePaths");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining("supportingInfra[supervisor-wake].evidencePaths"),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 的可选 supportingInfra 没有 evidencePaths 时不产生注意项", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-optional-no-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [{
            id: "optional-dashboard",
            declared: true,
            required: false,
            evidence: "nice-to-have dashboard helper",
          }],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain("evidence path 已存在");
      expect(check?.evidence).toContain("尚未验证自动启动");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 拒绝普通相对路径和穿越型证据路径", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-relative-reject-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [
            {
              id: "relative",
              declared: true,
              required: true,
              evidencePaths: ["relative/path.txt"],
            },
            {
              id: "traversal",
              declared: true,
              required: true,
              evidencePaths: ["${OPENRIG_HOME}/../escape.txt"],
            },
          ],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("relative/path.txt");
      expect(check?.evidence).toContain("${OPENRIG_HOME}/../escape.txt");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 的证据路径检查为只读", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-readonly-"));
    const daemonDir = path.join(tmpDir, "daemon");
    const supportDir = path.join(tmpDir, "supervisor-wake");
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(supportDir, { recursive: true });
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(daemonDir, "launchd.plist");
    const supportPath = path.join(supportDir, "README.md");
    fs.writeFileSync(daemonPath, "daemon evidence");
    fs.writeFileSync(supportPath, "support evidence");
    fs.utimesSync(tmpDir, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(tmpDir).mtimeMs;
    const readPaths: string[] = [];
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => {
          readPaths.push(p);
          return v2HostInfraDeclaration({
            daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          });
        },
      }));
      const result = service.check({ noQueue: true, noHooks: true });

      expect(result.verdict).toBe("restorable");
      expect(readPaths).toEqual([declarationPath]);
      expect(fs.statSync(tmpDir).mtimeMs).toBe(before);
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("主机基础设施读取异常在服务内部捕获为 unknown 注意项", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-read-error-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => {
          if (p === declarationPath) throw new Error("EACCES");
          return VALID_HOST_INFRA_DECLARATION;
        },
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("restorable_with_caveats");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.hostInfra.status).toBe("unknown");
      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("EACCES");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- 工作组规范/根目录检查 ---

  it("工作组根目录缺失时 spec-present 为 red", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes("rigs/test-rig"),
    }));
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("red");
    expect(spec?.evidence).toContain("缺少工作组根目录");
  });

  it("工作组根目录存在但缺少 rig.yaml 时 spec-present 为 yellow", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.endsWith("rig.yaml"),
    }));
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("yellow");
    expect(spec?.evidence).toContain("缺少 rig.yaml");
  });

  it("工作组根目录与 rig.yaml 均存在时 spec-present 为 green", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("green");
  });

  // --- 工作组级检查 ---

  it("快照缺失时产生 yellow（而非 red）", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({});
    const snap = result.checks.find((c) => c.check === "rig.test-rig.snapshot");
    expect(snap?.status).toBe("yellow");
  });

  // --- 席位级检查 ---

  it("智能体节点缺少转录时产生 yellow", () => {
    const service = new RestoreCheckService(mockDeps({ exists: (p) => !p.includes(".log") }));
    const result = service.check({});
    const transcript = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.transcript");
    expect(transcript?.status).toBe("yellow");
    expect(transcript?.evidence).toContain("缺少 transcript");
  });

  it("terminal/infra 节点免于转录检查，且不产生注意项", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        nodeId: "node-1",
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
      exists: () => false,
    }));
    const result = service.check({});
    const transcript = result.checks.find((c) => c.check === "seat.infra-board@test-rig.transcript");
    expect(transcript?.status).toBe("green");
    expect(transcript?.evidence).toContain("无需检查 transcript");
  });

  it("队列文件缺失时产生 yellow", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes("queue.md"),
    }));
    const result = service.check({});
    const queue = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.queue-file");
    expect(queue?.status).toBe("yellow");
      expect(queue?.evidence).toContain("缺少 queue 文件");
  });

  it("--no-queue 跳过队列文件检查", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noQueue: true });
    const queueChecks = result.checks.filter((c) => c.check.includes("queue-file"));
    expect(queueChecks).toHaveLength(0);
  });

  it("--no-hooks 跳过 hook 检查", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  it("项目本地设置包含两个必需 hook 时 Claude hook 检查为 green", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain(settingsPath);
      expect(hook?.evidence).toContain("hook 配置已存在");
      expect(hook?.evidence).toContain("尚未验证 hook 执行");
      expect(hook?.evidence).not.toContain("not yet implemented");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cwd 不可用时，主机全局设置满足条件可使 Claude hook 检查为 green", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-global-home-"));
    const settingsPath = path.join(home, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd: null })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain(settingsPath);
      expect(hook?.evidence).toContain("hook 配置已存在");
      expect(hook?.evidence).toContain("尚未验证 hook 执行");
      expect(hook?.evidence).not.toContain("cwd unavailable");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("必需 hooks 分布在主机全局与项目本地设置中时 Claude hook 检查为 green", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-merged-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-merged-cwd-"));
    const hostSettingsPath = path.join(home, ".claude", "settings.json");
    const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [hostSettingsPath]: claudeSettings({ userPromptSubmitCommand: null }),
          [localSettingsPath]: claudeSettings({ sessionStartCommand: null }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain("hook 配置已存在");
      expect(hook?.evidence).toContain("尚未验证 hook 执行");
      expect(hook?.evidence).toContain(hostSettingsPath);
      expect(hook?.evidence).toContain(localSettingsPath);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("仅配置一个必需 hook 时 Claude hook 检查为 yellow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-partial-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-partial-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [settingsPath]: claudeSettings({ userPromptSubmitCommand: null }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");
      const repair = result.repairPacket?.find((step) => step.rationale.includes("UserPromptSubmit"));

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("UserPromptSubmit");
      expect(hook?.evidence).toContain(REQUIRED_USER_PROMPT_SUBMIT_COMMAND);
      expect(repair).toEqual(expect.objectContaining({
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("适用的 Claude 设置格式错误时，即使另一范围有 hooks，检查仍为 yellow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-malformed-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-malformed-cwd-"));
    const hostSettingsPath = path.join(home, ".claude", "settings.json");
    const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [hostSettingsPath]: "{ not json",
          [localSettingsPath]: claudeSettings(),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain(hostSettingsPath);
      expect(hook?.evidence).toContain("不能信任 Claude hook 配置");
      expect(result.repairPacket?.find((step) => step.rationale.includes(hostSettingsPath))).toEqual(expect.objectContaining({
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Codex 与基础设施 hook 检查为 green 的不适用状态，且没有 hook 修复步骤", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [
        {
          rigId: "rig-1", rigName: "test-rig", logicalId: "dev.qa",
          podId: "dev", podNamespace: "dev",
          canonicalSessionName: "dev-qa@test-rig",
          nodeKind: "agent", runtime: "codex",
          sessionStatus: "running", startupStatus: "ready",
          tmuxAttachCommand: "tmux attach -t dev-qa@test-rig",
          latestError: null,
        } as NodeInventoryEntry,
        {
          rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
          podId: "infra", podNamespace: "infra",
          canonicalSessionName: "infra-board@test-rig",
          nodeKind: "infrastructure", runtime: "terminal",
          sessionStatus: "running", startupStatus: "ready",
          tmuxAttachCommand: null,
          latestError: null,
        } as NodeInventoryEntry,
      ],
    }));
    const result = service.check({});
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));

    expect(hookChecks).toHaveLength(2);
    for (const hook of hookChecks) {
      expect(hook.status).toBe("green");
      expect(hook.evidence).toContain("不适用 Claude Code hook 检查");
      expect(hook.remediation).toBe("");
    }
    expect(result.repairPacket?.some((step) => step.rationale.includes("Claude Code hook")) ?? false).toBe(false);
  });

  it("cwd 缺失时，仅当主机全局设置不满足 hooks，Claude hook 检查才为 yellow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-no-cwd-home-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {},
        nodes: [claudeNode({ cwd: null })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("cwd 不可用，因此未检查项目 settings");
      expect(hook?.evidence).toContain(path.join(home, ".claude", "settings.json"));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("Claude hook 匹配按事件局部执行且精确", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-event-local-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-event-local-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [settingsPath]: claudeSettings({
            sessionStartCommand: "./session-start-compact-context.sh",
            wrongEventCommand: REQUIRED_SESSION_START_COMPACT_COMMAND,
          }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("SessionStart matcher compact");
      expect(hook?.evidence).toContain(REQUIRED_SESSION_START_COMPACT_COMMAND);
      expect(hook?.evidence).not.toContain("configuration present");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Claude hook 检查仅读取现有设置文件", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-readonly-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-readonly-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    fs.utimesSync(cwd, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(cwd).mtimeMs;

    try {
      const { deps, readPaths } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd })],
        hostInfraDeclared: false,
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});

      expect(result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks")?.status).toBe("green");
      expect(readPaths).toEqual([settingsPath]);
      expect(readPaths).not.toContain(REQUIRED_SESSION_START_COMPACT_COMMAND);
      expect(readPaths).not.toContain(REQUIRED_USER_PROMPT_SUBMIT_COMMAND);
      expect(fs.statSync(cwd).mtimeMs).toBe(before);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("未配置 Claude hooks 时为 yellow，且不含旧占位符", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks.length).toBeGreaterThan(0);
    for (const hook of hookChecks) {
      expect(hook.status).toBe("yellow");
      expect(hook.evidence).toContain("Claude Code hook 配置缺少");
      expect(hook.evidence).not.toContain("not yet implemented");
    }
  });

  // --- 判定聚合 ---

  it("全部为 green 时产生 restorable 判定（使用 --no-hooks 避免 yellow 占位）", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as any;
    expect(result.verdict).toBe("restorable");
    expect(result.counts.red).toBe(0);
    expect(result.readiness.status).toBe("ready");
    expect(result.readiness).toEqual(expect.objectContaining({
      status: "ready",
      reason: "all_observable_checks_green_host_infra_declared_not_verified",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    }));
    expect(result.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
    }));
    expect(result.rigs).toEqual([
      expect.objectContaining({
        rigId: "rig-1",
        rigName: "test-rig",
        status: "ready",
        expectedNodes: 1,
        runningReadyNodes: 1,
        blockedNodes: 0,
        caveatNodes: 0,
        blockingChecks: [],
        caveatChecks: [],
      }),
    ]);
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("无需恢复 action"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("存在 yellow 且没有 red 时产生 restorable_with_caveats 判定", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.readiness.status).toBe("ready_with_caveats");
    expect(result.readiness.reason).toBe("caveats_present");
    expect(result.readiness.caveatRigCount).toBeGreaterThan(0);
    expect(result.counts.yellow).toBeGreaterThan(0);
    expect(result.counts.red).toBe(0);
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("无需恢复 action"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("存在任意 red 时产生 not_restorable 判定", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("not_restorable");
    expect(result.readiness.status).toBe("not_ready");
    expect(result.readiness.blockingRigCount).toBeGreaterThanOrEqual(0);
    expect(result.counts.red).toBeGreaterThan(0);
  });

  it("探测错误产生 unknown 就绪状态，而非假 green", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({}) as any;

    expect(result.verdict).toBe("unknown");
    expect(result.readiness.status).toBe("unknown");
    expect(result.readiness).toEqual(expect.objectContaining({
      status: "unknown",
      reason: "unknown_probe_state",
    }));
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "unknown",
      actions: [],
      blocked: [],
      unknown: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("无法确定状态"),
        }),
      ],
    }));
  });

  it("已停止且有快照支持的工作组产生可执行恢复命令", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: "dev-impl@test-rig",
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
        latestError: "seat crashed",
      })],
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 个工作组可用"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          action: "restore_from_latest_snapshot",
      command: "zrig up --existing test-rig",
          safe: false,
          blocking: true,
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("有最新快照但缺少规范会话身份时被阻塞，不可执行恢复", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: null,
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
        latestError: "seat crashed",
      })],
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "blocked",
      summary: expect.stringContaining("1 个工作组被阻塞"),
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          reason: expect.stringContaining("缺少 canonical session identity"),
        }),
      ],
      unknown: [],
    });
  });

  it("运行中/就绪节点有持久化启动上下文和所需文件时为 green", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-present.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "green",
      remediation: "",
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.repairPacket).toBeNull();
  });

  it("非就绪且有快照支持的节点缺少启动上下文时被阻塞，不可执行恢复", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        nodeId: "node-1" as never,
        sessionStatus: "stopped",
        startupStatus: "failed",
        latestError: "seat crashed",
      })],
      getStartupContext: () => startupContextProbe({
        status: "missing",
        evidence: "节点 node-1 缺少持久化 startup context",
      }) as never,
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
    }));
    expect(startup.evidence).toContain("缺少持久化 startup context");
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          reason: expect.stringContaining("缺少持久化 startup context"),
        }),
      ],
    }));
  });

  it("运行中/就绪节点缺少启动上下文时是 yellow 注意项，而非恢复阻塞项", () => {
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        status: "missing",
        evidence: "节点 node-1 缺少持久化 startup context",
      }) as never,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
    }));
    expect(startup.evidence).toContain("缺少持久化 startup context");
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("无需恢复 action"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("非就绪节点缺少必需启动文件时是 red 恢复输入阻塞项", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        sessionStatus: "stopped",
        startupStatus: "failed",
        latestError: "seat crashed",
      })],
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
      exists: (p) => p !== requiredPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          reason: expect.stringContaining(requiredPath),
        }),
      ],
    }));
  });

  it("运行中/就绪节点缺少必需启动文件时是 yellow 注意项", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-ready-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
      exists: (p) => p !== requiredPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.recovery.status).toBe("not_needed");
  });

  it("可选启动文件缺失时是 yellow 注意项", () => {
    const optionalPath = path.join(os.tmpdir(), "restore-check-startup-optional-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: optionalPath, required: false }],
      }) as never,
      exists: (p) => p !== optionalPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(optionalPath);
  });

  it("projection-entry 源路径缺失时是 yellow 注意项，而非阻塞项", () => {
    const projectionPath = path.join(os.tmpdir(), "restore-check-projection-source-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        projectionEntries: [{ absolutePath: projectionPath, effectiveId: "openrig-user", category: "guidance" }],
      }) as never,
      exists: (p) => p !== projectionPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(projectionPath);
    expect(result.recovery.status).toBe("not_needed");
  });

  it("已停止工作组没有最新快照但存在持久当前状态时可执行恢复", () => {
    const service = new RestoreCheckService(mockDeps({
      hasSnapshot: () => false,
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: "dev-impl@test-rig",
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
      })],
      getLatestSnapshot: () => null,
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 个工作组可用"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          command: "zrig up --existing test-rig",
          reason: expect.stringContaining("持久化当前 DB 状态"),
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("已停止的基础设施节点会体现在就绪状态中，并阻止 ready", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "stopped", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.readiness.blockingRigCount).toBe(1);
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 0,
      blockedNodes: 1,
      status: "not_ready",
    }));
    expect(result.rigs[0].blockingChecks.some((check: { check: string }) => check.check.includes("readiness"))).toBe(true);
    expect(result.repairPacket?.some((step: { blocking: boolean; safe: boolean }) => step.blocking && step.safe === false)).toBe(true);
  });

  it("运行中的基础设施节点免于转录检查，同时计为 ready", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        nodeId: "node-1",
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: "tmux attach -t infra-board@test-rig", latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.verdict).toBe("restorable");
    expect(result.readiness.status).toBe("ready");
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 1,
      blockedNodes: 0,
      caveatNodes: 0,
    }));
    const transcript = result.checks.find((check: { check: string }) => check.check === "seat.infra-board@test-rig.transcript");
    expect(transcript.status).toBe("green");
  });

  it("缺少规范会话身份时阻止 ready", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: null,
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.rigs[0].blockingChecks.some((check: { check: string; evidence: string }) => (
      check.check.includes("readiness") && check.evidence.includes("canonical session")
    ))).toBe(true);
  });

  // --- 工作组过滤器 ---

  it("--rig 仅筛选具名工作组", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => [
        { rigId: "rig-1", name: "rig-a" },
        { rigId: "rig-2", name: "rig-b" },
      ],
    }));
    const result = service.check({ rig: "rig-a" });
    // 仅包含工作组特定检查与席位检查——没有 rig-b 污染。
    const rigSpecificChecks = result.checks.filter((c) => c.check.startsWith("rig.") || c.check.startsWith("seat."));
    expect(rigSpecificChecks.length).toBeGreaterThan(0);
    expect(rigSpecificChecks.some((c) => c.check.includes("rig-b"))).toBe(false);
  });

  it("--rig 使用未知名称时产生 red", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ rig: "nonexistent" });
    expect(result.verdict).toBe("not_restorable");
    const notFound = result.checks.find((c) => c.check.includes("nonexistent"));
    expect(notFound?.status).toBe("red");
  });

  // --- JSON 结构 ---

  it("restorable 结果的 repairPacket 为 null", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.verdict).toBe("restorable");
    expect(result.repairPacket).toBeNull();
  });

  it("not_restorable 结果包含显式严重度的阻塞修复步骤", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));

    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("not_restorable");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "启动后台服务：zrig daemon start",
        rationale: "Daemon not running",
        blocking: true,
        safe: expect.any(Boolean),
      }),
    ]);
  });

  it("restorable_with_caveats 结果包含带自然语言操作的非阻塞修复步骤", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes(".log"),
    }));

    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "下次启动会话时将创建 transcript",
        rationale: expect.stringContaining("缺少 transcript"),
        blocking: false,
        safe: expect.any(Boolean),
      }),
    ]);
  });

  it("repairPacket 将阻塞项排在注意项之前，并保持步骤从 1 编号", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
      hasSnapshot: () => false,
    }));

    const result = service.check({ noHooks: true });
    const packet = result.repairPacket as Array<{ step: number; command: string; blocking: boolean }> | null;

    expect(packet).not.toBeNull();
    expect(packet?.map((entry) => entry.step)).toEqual([1, 2]);
    expect(packet?.[0]).toEqual(expect.objectContaining({
      command: "启动后台服务：zrig daemon start",
      blocking: true,
    }));
    expect(packet?.[1]).toEqual(expect.objectContaining({
      command: "创建快照：zrig snapshot <rigId>",
      blocking: false,
    }));
  });

  it("unknown 结果包含阻塞恢复的探测修复步骤，但不改变判定", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));

    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "启动后台服务：zrig daemon start",
        rationale: expect.stringContaining("无法确定状态"),
        blocking: true,
        safe: expect.any(Boolean),
      }),
    ]);
  });

  it("每项检查都含 check/status/evidence/remediation 字段", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    for (const check of result.checks) {
      expect(typeof check.check).toBe("string");
      expect(["green", "yellow", "red"]).toContain(check.status);
      expect(typeof check.evidence).toBe("string");
      expect(typeof check.remediation).toBe("string");
    }
  });

  // --- 切片 2：修复包 ---

  it("not_restorable 判定的 repairPacket 为 red 检查提供 blocking:true 条目", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.verdict).toBe("not_restorable");
    expect(result.repairPacket).not.toBeNull();
    expect(result.repairPacket!.length).toBeGreaterThan(0);

    const blocker = result.repairPacket!.find((s) => s.blocking);
    expect(blocker).toBeDefined();
    expect(blocker!.step).toBe(1);
    expect(typeof blocker!.command).toBe("string");
    expect(blocker!.command.length).toBeGreaterThan(0);
    expect(typeof blocker!.rationale).toBe("string");
    // 启动后台服务会产生变更 → safe: false。
    expect(blocker!.safe).toBe(false);
    expect(blocker!.blocking).toBe(true);
  });

  it("restorable_with_caveats 的 repairPacket 为 yellow 检查提供 blocking:false 条目", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.repairPacket).not.toBeNull();

    const caveat = result.repairPacket!.find((s) => !s.blocking);
    expect(caveat).toBeDefined();
    // 创建快照会产生变更 → safe: false。
    expect(caveat!.safe).toBe(false);
    expect(caveat!.blocking).toBe(false);
  });

  it("restorable 判定的 repairPacket 为 null（无需修复）", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("restorable");
    expect(result.repairPacket).toBeNull();
  });

  it("修复包将阻塞项排在注意项之前，步骤从 1 编号", () => {
    // red 后台服务 + yellow 快照缺失 = 阻塞项在前，注意项在后。
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
      hasSnapshot: () => false,
    }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.repairPacket).not.toBeNull();
    const steps = result.repairPacket!;
    expect(steps.length).toBeGreaterThanOrEqual(2);
    // 第一项应为阻塞项（后台服务 red）。
    expect(steps[0]!.blocking).toBe(true);
    expect(steps[0]!.step).toBe(1);
    // 最后一项应为注意项（快照 yellow）。
    const lastCaveat = steps.find((s) => !s.blocking);
    expect(lastCaveat).toBeDefined();
    // 步骤连续编号。
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i]!.step).toBe(i + 1);
    }
  });

  it("unknown 判定的 repairPacket 包含 blocking:true 条目", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => { throw new Error("database locked"); },
    }));
    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).not.toBeNull();
    const entry = result.repairPacket![0]!;
    expect(entry.blocking).toBe(true);
  });

  it("修复条目的 command 包含自然语言指导，而非 shell 命令前缀", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.repairPacket).not.toBeNull();
    const snapshotStep = result.repairPacket!.find((s) => s.rationale.includes("快照"));
    expect(snapshotStep).toBeDefined();
    // Command 是自然语言指导，不以 $ 开头，也不可自动执行。
    expect(snapshotStep!.command).not.toMatch(/^\$/);
    expect(snapshotStep!.command.length).toBeGreaterThan(0);
  });

  it("省略 remediationSafe 时默认 safe:false（保守）", () => {
    // getNodeInventory 抛出异常时的 remediation 为“检查后台服务状态”，未显式提供
    // remediationSafe——保守默认值必须产生 safe:false。
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => { throw new Error("query timeout"); },
    }));
    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).not.toBeNull();
    const entry = result.repairPacket!.find((s) => s.rationale.includes("query timeout"));
    expect(entry).toBeDefined();
    // 省略 remediationSafe → safe:false（保守默认值）。
    expect(entry!.safe).toBe(false);
    expect(entry!.blocking).toBe(true);
  });

  it("新的就绪修复步骤区分并保留阻塞严重度与执行安全性", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig",
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "stopped", startupStatus: "failed",
        tmuxAttachCommand: null, latestError: "launch failed",
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true });
    const readinessRepair = result.repairPacket?.find((step) => step.rationale.includes("未处于 running/ready"));

    expect(readinessRepair).toEqual(expect.objectContaining({
      blocking: true,
      safe: false,
    }));
  });

  // --- H62 缺失证明 ---

  it("结果没有顶层 fullyBack 字段", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as Record<string, unknown>;
    expect("fullyBack" in result).toBe(false);
  });

  it("结果没有顶层 assertion 字段", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as Record<string, unknown>;
    expect("assertion" in result).toBe(false);
  });

  it("逐工作组状态使用就绪词汇，而非 fully_back/not_fully_back", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    for (const rig of result.rigs) {
      expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(rig.status);
      expect(rig.status).not.toBe("fully_back");
      expect(rig.status).not.toBe("not_fully_back");
    }
  });

  // --- H62 连续性断言 ---

  it("v1 中 continuity 始终为 not_proven，且填充 unprovenCapabilities", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.continuity.status).toBe("not_proven");
    expect(result.continuity.evidence).toBeTruthy();
    expect(result.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
    expect(result.continuity.unprovenCapabilities).toContain("provider_session_resume");
    expect(result.continuity.unprovenCapabilities).toContain("context_window_preservation");
    expect(result.continuity.unprovenCapabilities).toContain("interrupted_work_functional_resume");
  });

  it("全部可观测检查均为 green 的工作组，continuity 仍为 not_proven", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.readiness.status).toBe("ready");
    expect(result.continuity.status).toBe("not_proven");
  });

  it("unknown/探测错误结果的 continuity 为 not_proven", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({});
    expect(result.readiness.status).toBe("unknown");
    expect(result.continuity.status).toBe("not_proven");
  });
});
