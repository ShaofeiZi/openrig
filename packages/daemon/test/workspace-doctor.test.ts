// Slice-21 FR-5——工作区诊断检查单元测试。
//
// 按已沉淀的 feedback_handoff_body_claims_need_discriminator_verification，
// 每项检查都附带判别器翻转反例：若生产代码出错，断言就会捕获。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkWorkspaceRootReachable,
  checkMissionsFolder,
  checkFileAllowlist,
  checkDaemonWorkspace,
  checkDaemonReload,
  checkOptionalSliceDocs,
  checkMissionNotesPresence,
  checkSdlcConventionSections,
  runWorkspaceDoctor,
  type DoctorCheck,
} from "../src/domain/workspace/workspace-doctor.js";

const CONVENTION_BODY = "# S\n## Intent\nx\n## Mini-requirements\n1. y\n## Proof contract\n- [ ] z\n";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-doctor-"));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("FR-5 check #1 — workspace root reachable", () => {
  it("工作区根目录存在且为目录时返回 ok", () => {
    const result: DoctorCheck = checkWorkspaceRootReachable({ workspaceRoot: dir, source: "default" });
    expect(result.check).toBe("workspace_root_reachable");
    expect(result.status).toBe("ok");
    expect(result.message).toContain(dir);
    expect(result.fixHint).toBeUndefined();
    expect(result.evidence).toEqual({ workspaceRoot: dir, source: "default" });
  });

  // 判别器翻转：ENOENT 路径必须失败，不能静默通过。
  it("工作区根目录不存在时返回 fail，并附 ENOENT 证据", () => {
    const missing = path.join(dir, "definitely-not-here");
    const result = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("不存在");
    expect(result.message).toContain("env");
    expect(result.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  // 判别器翻转：根路径是文件而非目录时必须失败。若没有 isDirectory() 检查，
  // statSync 会成功且检查会返回 ok；本测试捕获该回归。
  it("工作区根路径是普通文件而非目录时返回 fail", () => {
    const filePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(filePath, "");
    const result = checkWorkspaceRootReachable({ workspaceRoot: filePath, source: "file" });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("不是目录");
    expect(result.fixHint).toContain("config.json");
    expect(result.evidence?.kind).toBe("not_a_directory");
  });

  // 感知来源的修复提示判别器。若修复提示解析硬编码为单一来源，本测试会捕获。
  it("根据来源给出修复提示（环境变量、文件或默认值）", () => {
    const missing = path.join(dir, "missing");
    const envResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "env" });
    const fileResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "file" });
    const defaultResult = checkWorkspaceRootReachable({ workspaceRoot: missing, source: "default" });
    expect(envResult.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    expect(envResult.fixHint).not.toContain("config.json 中的 workspace.root");
    expect(fileResult.fixHint).toContain("config.json 中的 workspace.root");
    expect(fileResult.fixHint).not.toContain("OPENRIG_WORKSPACE_ROOT");
    expect(defaultResult.fixHint).toContain("zrig config init-workspace");
  });

  // 判别器翻转：非 ENOENT 的 I/O 错误仍必须失败，并提供有用消息和 evidence.errorCode
  //（如权限拒绝时的 EACCES）。通过将已创建子目录 chmod 000 模拟。
  it("非 ENOENT 的 stat 错误返回 fail，并附 errorCode 证据", () => {
    // 在 chmod 不限制 stat 的平台（如 Windows 或 root 用户）跳过。该检查是所需的判别器翻转，
    // 但必须适应不同测试环境。
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const lockedParent = path.join(dir, "locked-parent");
    fs.mkdirSync(lockedParent);
    const inside = path.join(lockedParent, "inside");
    fs.mkdirSync(inside);
    try {
      fs.chmodSync(lockedParent, 0o000);
      const result = checkWorkspaceRootReachable({ workspaceRoot: inside, source: "env" });
      expect(result.status).toBe("fail");
      expect(result.evidence?.errorCode).toBeDefined();
      expect(result.evidence?.errorCode).not.toBe("unknown");
    } finally {
      fs.chmodSync(lockedParent, 0o700);
    }
  });
});

describe("FR-5 check #2 — missions folder present", () => {
  it("默认 missions 目录存在时返回 ok", () => {
    const missionsDir = path.join(dir, "missions");
    fs.mkdirSync(missionsDir);
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: missionsDir });
    expect(result.check).toBe("missions_folder_present");
    expect(result.status).toBe("ok");
    expect(result.evidence?.slicesRoot).toBe(missionsDir);
  });

  // 判别器翻转：由于 slicesRoot 等于 workspaceRoot/missions，目录缺失必须失败并给出默认修复提示。
  it("默认 missions 目录缺失时返回 fail，并附默认修复提示", () => {
    const missing = path.join(dir, "missions");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: missing });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("zrig config init-workspace");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  // 判别器翻转：操作人员覆盖 slicesRoot 后，修复提示不应建议运行 init-workspace；
  // 该命令会在工作区根目录创建默认 missions/，而非自定义路径。
  it("覆盖后的 slicesRoot 缺失时返回 fail，并附自定义路径修复提示", () => {
    const custom = path.join(dir, "custom-elsewhere");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: custom });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("取消设置 workspace.slices_root");
    expect(result.fixHint).not.toContain("zrig config init-workspace");
  });

  // 判别器翻转：missions 路径是文件。若没有 isDirectory() 门，检查会错误返回 ok。
  it("missions 路径是普通文件时返回 fail", () => {
    const filePath = path.join(dir, "missions");
    fs.writeFileSync(filePath, "");
    const result = checkMissionsFolder({ workspaceRoot: dir, slicesRoot: filePath });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("不是目录");
    expect(result.evidence?.kind).toBe("not_a_directory");
  });
});

describe("FR-5 检查 #3——文件 allowlist 合理", () => {
  it("allowlist 至少有一个条目覆盖工作区根目录时返回 ok", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `workspace:${dir}`,
      allowlistSource: "default",
    });
    expect(result.check).toBe("file_allowlist_sane");
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // 判别器翻转：空值必须失败；没有 entries.length === 0 检查时会进入覆盖逻辑。
  it("allowlist 为空时返回 fail，并附明确修复提示", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "",
      allowlistSource: "default",
    });
    expect(result.status).toBe("fail");
    expect(result.fixHint).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(result.fixHint).toContain("rig config set");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // 判别器翻转：无法解析的值（无冒号）必须失败。若 parseAllowlistPairs 不要求冒号，
  // 垃圾值会通过。
  it("allowlist 畸形（无冒号）时返回 fail", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "garbage-no-colon-here",
      allowlistSource: "env",
    });
    expect(result.status).toBe("fail");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // 判别器翻转：allowlist 含合法条目但没有任何条目覆盖工作区时必须警告（不是 ok 或 fail）。
  // 若没有 covers 检查，会错误返回 ok。
  it("allowlist 条目合法但均未覆盖工作区根目录时返回 warn", () => {
    const elsewhere = path.join(dir, "elsewhere-1");
    fs.mkdirSync(elsewhere);
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `other:${elsewhere}`,
      allowlistSource: "file",
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("没有任何条目覆盖工作区根目录");
    expect(result.fixHint).toContain("workspace:");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // 子目录覆盖判别器：作为工作区根目录祖先的 allowlist 条目应覆盖它。
  it("allowlist 条目是工作区根目录祖先时返回 ok", () => {
    const sub = path.join(dir, "deep-sub");
    fs.mkdirSync(sub);
    const result = checkFileAllowlist({
      workspaceRoot: sub,
      allowlistValue: `parent:${dir}`,
      allowlistSource: "env",
    });
    expect(result.status).toBe("ok");
  });

  // 预解码条目路径：预解析条目应绕过权威 decoder，并逐字采用。判别方法是传入 decoder
  // 不可能生成的条目形状。
  it("提供预解码条目时使用它们", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "raw-value-different-from-entries",
      allowlistSource: "default",
      parsedEntries: [{ name: "ws", path: fs.realpathSync(dir) }],
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });

  // GUARD BLOCKER-1 判别器（qitem-20260602041334-55985aa9）：`workspace:.` 这样的相对路径
  // 不得静默解析到 process.cwd() 后返回 ok。已交付文件 API 的 decodeAllowlist 会在
  // path-safety.ts:71 静默丢弃非绝对路径；doctor 必须保持一致，否则会谎报工作区可读取。
  it("allowlist 仅含相对路径时返回 fail（对应已交付文件 API 的丢弃行为）", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "workspace:.",
      allowlistSource: "file",
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("未解析出可用条目");
    expect(result.fixHint).toContain("仅限绝对路径");
    expect(result.evidence?.entryCount).toBe(0);
  });

  it("allowlist 混入仅相对条目且没有绝对路径兜底时返回 fail", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: "workspace:relative/path/here",
      allowlistSource: "env",
    });
    expect(result.status).toBe("fail");
    expect(result.evidence?.entryCount).toBe(0);
  });

  // 正向守卫判别器：畸形相对条目应被丢弃，但同行的合法绝对条目仍应使结果为 ok。
  // 这防止过度修复导致只要存在相对条目就让整项检查失败。
  it("allowlist 同时含被丢弃的相对路径和覆盖根目录的保留绝对路径时返回 ok", () => {
    const result = checkFileAllowlist({
      workspaceRoot: dir,
      allowlistValue: `bad:./relative,workspace:${dir}`,
      allowlistSource: "env",
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.entryCount).toBe(1);
  });
});

describe("FR-5 check #4 — daemon points at this workspace", () => {
  it("后台服务与调用方对工作区根目录一致时返回 ok", () => {
    const result = checkDaemonWorkspace({ daemonResolvedRoot: dir, expectedRoot: dir });
    expect(result.check).toBe("daemon_points_at_this_workspace");
    expect(result.status).toBe("ok");
  });

  // 判别器翻转：路径不同必须失败。没有字符串比较时，检查会错误返回 ok。
  it("后台服务解析出不同工作区根目录时返回 fail", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-other-"));
    try {
      const result = checkDaemonWorkspace({
        daemonResolvedRoot: otherDir,
        expectedRoot: dir,
      });
      expect(result.status).toBe("fail");
      expect(result.message).toContain(otherDir);
      expect(result.message).toContain(dir);
      expect(result.fixHint).toContain("rig daemon restart");
      expect(result.fixHint).toContain("OPENRIG_WORKSPACE_ROOT");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // 判别器翻转：path.resolve 归一化。带冗余 `./` 段但等价于预期路径的后台服务路径，
  // 归一化后仍应相等。
  it("比较前归一化路径", () => {
    const result = checkDaemonWorkspace({
      daemonResolvedRoot: path.join(dir, ".", "sub", ".."),
      expectedRoot: dir,
    });
    expect(result.status).toBe("ok");
  });
});

describe("FR-5 check #5 — daemon reload needed", () => {
  it("配置文件早于后台服务启动时返回 ok", () => {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, "{}");
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(cfg, oldMtime, oldMtime);
    const start = new Date(Date.now() - 5_000);
    const result = checkDaemonReload({ configFilePath: cfg, daemonStartTime: start });
    expect(result.check).toBe("daemon_reload_needed");
    expect(result.status).toBe("ok");
  });

  // 判别器翻转：配置晚于后台服务启动时必须警告。没有 mtimeMs > startMs 比较，
  // 新鲜度检查永远不会触发。
  it("配置文件 mtime 晚于后台服务启动时返回 warn", () => {
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, "{}");
    const newMtime = new Date(Date.now());
    fs.utimesSync(cfg, newMtime, newMtime);
    const start = new Date(Date.now() - 60_000);
    const result = checkDaemonReload({ configFilePath: cfg, daemonStartTime: start });
    expect(result.status).toBe("warn");
    expect(result.fixHint).toContain("rig daemon restart");
    expect(result.evidence?.staleMs).toBeGreaterThan(0);
  });

  // 判别器翻转：ENOENT 不得失败或警告。仅使用默认值运行（无配置文件）的后台服务是健康状态。
  it("配置文件不存在时返回 ok（后台服务仅使用默认值）", () => {
    const missing = path.join(dir, "no-such-config.json");
    const result = checkDaemonReload({
      configFilePath: missing,
      daemonStartTime: new Date(),
    });
    expect(result.status).toBe("ok");
    expect(result.evidence?.configFileExists).toBe(false);
  });
});

describe("FR-5 check #6 — optional slice docs", () => {
  it("每个 slice 都有 README、IMPLEMENTATION-PRD 或 IMPL-PRD 时返回 ok", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "s1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m1", "slices", "s2"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "s1", "README.md"), "");
    fs.writeFileSync(path.join(missions, "m1", "slices", "s2", "IMPL-PRD.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.check).toBe("optional_slice_docs");
    expect(result.status).toBe("ok");
    expect(result.evidence?.bareSlices).toEqual([]);
  });

  // 判别器翻转：两种文档形状都没有的 slice 必须警告。没有 SLICE_DOC_FILES.some() 检查，
  // 裸 slice 会静默通过。
  it("对没有文档结构的裸 slice 返回 warn 并点名", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "bare-slice"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m1", "slices", "ok-slice"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "ok-slice", "README.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.status).toBe("warn");
    const bare = result.evidence?.bareSlices as Array<{ mission: string; slice: string }>;
    expect(bare).toHaveLength(1);
    expect(bare[0]?.slice).toBe("bare-slice");
  });

  // 判别器翻转：三个文档文件名中的任意一个都应通过。
  it("将 IMPLEMENTATION-PRD.md 与 README.md、IMPL-PRD.md 等同处理", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "s1", "IMPLEMENTATION-PRD.md"), "");
    const result = checkOptionalSliceDocs({ missionsRoot: missions });
    expect(result.status).toBe("ok");
  });

  // 判别器翻转：missions 根目录缺失必须警告而非失败。按 IMPL-PRD §57-59，本检查仅告警。
  it("missions 根目录缺失时返回 warn 而非 fail", () => {
    const result = checkOptionalSliceDocs({ missionsRoot: path.join(dir, "no-missions") });
    expect(result.status).toBe("warn");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });
});

describe("FR-5 check #7 — mission notes presence", () => {
  it("为每个 mission 使用当前优先、旧版兜底的解析顺序", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m2"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m3"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "NOTES.md"), "");
    fs.writeFileSync(path.join(missions, "m2", "MISSION_NOTES.md"), "");
    fs.writeFileSync(path.join(missions, "m3", "NOTES.md"), "current");
    fs.writeFileSync(path.join(missions, "m3", "MISSION_NOTES.md"), "legacy");
    const result = checkMissionNotesPresence({ missionsRoot: missions });
    expect(result.check).toBe("mission_notes_presence");
    expect(result.status).toBe("ok");
    expect(result.evidence?.missing).toEqual([]);
  });

  // 判别器翻转：缺少 MISSION_NOTES 必须警告并点名具体 mission，否则操作人员无法行动。
  it("对缺少 MISSION_NOTES.md 的 mission 返回 warn 并点名", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "with-notes"), { recursive: true });
    fs.mkdirSync(path.join(missions, "no-notes-1"), { recursive: true });
    fs.mkdirSync(path.join(missions, "no-notes-2"), { recursive: true });
    fs.writeFileSync(path.join(missions, "with-notes", "MISSION_NOTES.md"), "");
    const result = checkMissionNotesPresence({ missionsRoot: missions });
    expect(result.status).toBe("warn");
    const missing = result.evidence?.missing as Array<{ mission: string }>;
    expect(missing.map((m) => m.mission).sort()).toEqual(["no-notes-1", "no-notes-2"]);
    expect(result.fixHint).toContain("rig scope mission create");
  });

  // 判别器翻转：missions 根目录缺失应只告警。
  it("missions 根目录缺失时返回 warn 而非 fail", () => {
    const result = checkMissionNotesPresence({ missionsRoot: path.join(dir, "no-missions") });
    expect(result.status).toBe("warn");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });
});

describe("FR-5 runWorkspaceDoctor — orchestrator", () => {
  function scaffoldHealthyWorkspace(root: string): { missions: string; configPath: string } {
    const missions = path.join(root, "missions");
    fs.mkdirSync(missions);
    fs.mkdirSync(path.join(missions, "getting-started"));
    fs.writeFileSync(path.join(missions, "getting-started", "MISSION_NOTES.md"), "");
    fs.mkdirSync(path.join(missions, "getting-started", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(missions, "getting-started", "slices", "s1", "README.md"), CONVENTION_BODY);
    const configPath = path.join(root, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    const oldMtime = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath, oldMtime, oldMtime);
    return { missions, configPath };
  }

  it("健康工作区返回含汇总计数的 8 项检查报告", () => {
    const { missions, configPath } = scaffoldHealthyWorkspace(dir);
    const report = runWorkspaceDoctor({
      workspaceRoot: dir,
      workspaceRootSource: "env",
      slicesRoot: missions,
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: dir,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.workspaceRoot).toBe(dir);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.map((c) => c.check)).toEqual([
      "workspace_root_reachable",
      "missions_folder_present",
      "file_allowlist_sane",
      "daemon_points_at_this_workspace",
      "daemon_reload_needed",
      "optional_slice_docs",
      "mission_notes_presence",
      "sdlc_convention_sections",
    ]);
    expect(report.summary.ok).toBe(8);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(typeof report.daemonResolvedAt).toBe("string");
    expect(report.daemonResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // 判别器翻转：至少一项检查告警时，orchestrator 必须汇总 WARN 状态。
  // 若没有 for-loop 摘要计数，结果会保持 0/0/0。
  it("单项检查告警（缺少 mission notes）时汇总 warn 数量", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1"), { recursive: true });
    // 刻意不创建 MISSION_NOTES.md。
    const configPath = path.join(dir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    fs.utimesSync(configPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const report = runWorkspaceDoctor({
      workspaceRoot: dir,
      workspaceRootSource: "env",
      slicesRoot: missions,
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: dir,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.summary.warn).toBeGreaterThanOrEqual(1);
    const notes = report.checks.find((c) => c.check === "mission_notes_presence");
    expect(notes?.status).toBe("warn");
  });

  // 判别器翻转：至少一项检查失败时，orchestrator 必须汇总 FAIL 状态。
  // 工作区根目录无效时，路由检查 #1 会失败。
  it("工作区根目录不可达时汇总 fail 数量", () => {
    const bogus = path.join(dir, "does-not-exist");
    const configPath = path.join(dir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    fs.utimesSync(configPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const report = runWorkspaceDoctor({
      workspaceRoot: bogus,
      workspaceRootSource: "env",
      slicesRoot: path.join(bogus, "missions"),
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: bogus,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    const reachable = report.checks.find((c) => c.check === "workspace_root_reachable");
    expect(reachable?.status).toBe("fail");
  });

  // 判别器翻转：检查顺序稳定。CLI 人类可读 formatter（FR-5d）按此顺序分组；
  // checks[] 重排会破坏 formatter 的类别假设。
  it("无论输入时序如何，都按文档规定的固定顺序输出检查", () => {
    const { missions, configPath } = scaffoldHealthyWorkspace(dir);
    const reports = Array.from({ length: 3 }, () =>
      runWorkspaceDoctor({
        workspaceRoot: dir,
        workspaceRootSource: "env",
        slicesRoot: missions,
        allowlistValue: `workspace:${fs.realpathSync(dir)}`,
        allowlistSource: "default",
        daemonResolvedWorkspaceRoot: dir,
        configFilePath: configPath,
        daemonStartTime: new Date(Date.now() - 5_000),
      }),
    );
    const fingerprints = reports.map((r) => r.checks.map((c) => c.check).join(","));
    expect(new Set(fingerprints).size).toBe(1);
  });
});

// OPR.0.4.4.23 检查 #8——SDLC 约定章节（建议性警告）。
describe("OPR.0.4.4.23 check #8 — SDLC convention sections", () => {
  it("每个 slice README 都包含三个约定章节时返回 ok", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "s1", "README.md"), CONVENTION_BODY);
    const result = checkSdlcConventionSections({ missionsRoot: missions });
    expect(result.check).toBe("sdlc_convention_sections");
    expect(result.status).toBe("ok");
    expect(result.evidence?.offenders).toEqual([]);
  });

  // 判别器翻转：旧形状 README（Goal/Acceptance）必须警告并点名缺失章节。
  it("对 README 缺少约定章节的 slice 返回 warn 并点名", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "old-shape"), { recursive: true });
    fs.mkdirSync(path.join(missions, "m1", "slices", "ok-slice"), { recursive: true });
    fs.writeFileSync(path.join(missions, "m1", "slices", "old-shape", "README.md"), "# S\n## Goal\nx\n## Acceptance\n- y\n");
    fs.writeFileSync(path.join(missions, "m1", "slices", "ok-slice", "README.md"), CONVENTION_BODY);
    const result = checkSdlcConventionSections({ missionsRoot: missions });
    expect(result.status).toBe("warn");
    const offenders = result.evidence?.offenders as Array<{ slice: string; missing: string[] }>;
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.slice).toBe("old-shape");
    expect(offenders[0]?.missing).toEqual(["## Intent", "## Mini-requirements", "## Proof contract"]);
  });

  // 失败开放边界：没有 README 的 slice 属于检查 #6 的发现，不是本检查的章节违规项，
  // 避免重复报告。
  it("跳过没有 README 的 slice（裸 slice 由检查 #6 负责）", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(path.join(missions, "m1", "slices", "bare"), { recursive: true });
    const result = checkSdlcConventionSections({ missionsRoot: missions });
    expect(result.status).toBe("ok");
    expect(result.evidence?.slicesChecked).toBe(0);
  });

  // 建议性姿态：missions 根目录缺失只警告，绝不失败。
  it("missions 根目录缺失时返回 warn 而非 fail", () => {
    const result = checkSdlcConventionSections({ missionsRoot: path.join(dir, "no-missions") });
    expect(result.status).toBe("warn");
    expect(result.evidence?.errorCode).toBe("ENOENT");
  });

  it("runWorkspaceDoctor 在报告中包含检查 #8", () => {
    const missions = path.join(dir, "missions");
    fs.mkdirSync(missions, { recursive: true });
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, "{}");
    const report = runWorkspaceDoctor({
      workspaceRoot: dir,
      workspaceRootSource: "env",
      slicesRoot: missions,
      allowlistValue: `workspace:${fs.realpathSync(dir)}`,
      allowlistSource: "default",
      daemonResolvedWorkspaceRoot: dir,
      configFilePath: configPath,
      daemonStartTime: new Date(Date.now() - 5_000),
    });
    expect(report.checks.some((c) => c.check === "sdlc_convention_sections")).toBe(true);
    expect(report.checks).toHaveLength(8);
  });
});
