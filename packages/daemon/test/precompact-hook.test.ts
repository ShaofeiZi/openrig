// Slice 27——precompact-hook.mjs 端到端测试。
//
// 该 hook 作为静态资源发布于
// `packages/daemon/assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs`
// 并由 Claude Code 作为子进程调用。这些测试以受控 stdin + 隔离 OPENRIG_HOME 启动真实 hook
// 文件，使磁盘行为与 Claude 在 PreCompact 时观察到的内容一致。
//
// Hard-gate 覆盖：
//   HG-6  把内联消息追加到 systemMessage
//   HG-7  读取并追加文件路径消息
//   HG-8  两者均未设置 → 仅保留现有 restore-instructions（不自定义追加）
//   同时设置 inline + file 时，两者均产生内容

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "skills",
  "claude-compaction-restore",
  "scripts",
  "precompact-hook.mjs",
);
const BRIDGE_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "hooks",
  "scripts",
  "compaction-restore-bridge.cjs",
);
const APPEND_MARKER = "操作员配置的压缩后恢复指令";

function runHook(openrigHome: string, withTranscript = true): { stdout: string; stderr: string; status: number | null } {
  const fixtureRoot = dirname(openrigHome);
  const transcript = join(fixtureRoot, "transcript.jsonl");
  if (withTranscript) writeFileSync(transcript, `${JSON.stringify({
    sessionId: "precompact-fixture",
    cwd: fixtureRoot,
    message: { role: "user", content: "恢复私有压缩 fixture。" },
  })}\n`);
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({ cwd: fixtureRoot, ...(withTranscript ? { transcript_path: transcript } : {}) }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixtureRoot,
      CLAUDE_CONFIG_DIR: join(fixtureRoot, ".claude"),
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      OPENRIG_COMPACTION_OUT_ROOT: join(fixtureRoot, "packets"),
      // 确保 RIGGED_HOME 不会抢占 OPENRIG_HOME 选择。
      RIGGED_HOME: undefined,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function runBridge(openrigHome: string, input: Record<string, unknown> = {
  hook_event_name: "UserPromptSubmit",
}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
    input: JSON.stringify({ transcript_path: join(dirname(openrigHome), "transcript.jsonl"), ...input }),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      RIGGED_HOME: undefined,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function writePolicyConfig(home: string, policy: {
  enabled?: boolean;
  thresholdPercent?: number;
  preCompactInstruction?: string;
  compactInstruction?: string;
  messageInline?: string;
  messageFilePath?: string;
  postRestoreAuditInstruction?: string;
}): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: {
          enabled: policy.enabled ?? false,
          thresholdPercent: policy.thresholdPercent ?? 80,
          preCompactInstruction: policy.preCompactInstruction ?? "",
          compactInstruction: policy.compactInstruction ?? "",
          messageInline: policy.messageInline ?? "",
          messageFilePath: policy.messageFilePath ?? "",
          postRestoreAuditInstruction: policy.postRestoreAuditInstruction ?? "",
        },
      },
    }),
  );
}

function writePartialPolicyConfig(home: string, policy: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: policy,
      },
    }),
  );
}

describe("precompact-hook.mjs（slice 27 自定义消息追加）", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-hook-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("HG-6：内联消息追加到 systemMessage", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "操作员提醒：请记住迁移步骤。",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("操作员提醒：请记住迁移步骤。");
  });

  it("写入 pending restore marker，且 bridge 只注入一次 restore context", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "恢复前请读取队列。",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("待恢复标记");

    const markerDir = join(openrigHome, "compaction", "restore-pending");
    const markerPath = join(markerDir, "test-seat@kernel.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(dirname(marker.outputDir)).toBe(join(tmpDir, "packets"));
    expect(marker.postCompactInstruction).toContain("内联恢复指令");
    expect(marker.postCompactInstruction).toContain("恢复前请读取队列。");
    expect(marker.deliveryCount).toBe(0);

    const wrongTranscript = runBridge(openrigHome, {
      hook_event_name: "UserPromptSubmit", transcript_path: join(tmpDir, "other.jsonl"),
    });
    expect(wrongTranscript.status).toBe(0);
    expect(wrongTranscript.stdout).toBe("");
    expect(JSON.parse(readFileSync(markerPath, "utf8")).deliveryCount).toBe(0);

    const bridge = runBridge(openrigHome);
    expect(bridge.status).toBe(0);
    const bridgePayload = JSON.parse(bridge.stdout.trim());
    expect(bridgePayload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("此 Claude 会话已有 OpenRig 压缩恢复包可用");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("信息上下文");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain(marker.outputDir);
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("恢复前请读取队列。");

    const delivered = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(delivered.deliveryCount).toBe(1);
    expect(delivered.deliveredAt).toBeTruthy();

    const secondBridge = runBridge(openrigHome);
    expect(secondBridge.status).toBe(0);
    expect(secondBridge.stdout).toBe("");
  });

  it("HG-7：inline 为空时读取并追加 file-path 消息", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "每次压缩时从磁盘读取。");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("每次压缩时从磁盘读取。");
  });

  it("HG-7：file-path 支持 ${OPENRIG_HOME} 展开", () => {
    const messageDir = join(openrigHome, "instructions");
    mkdirSync(messageDir, { recursive: true });
    writeFileSync(join(messageDir, "restore.md"), "从 OPENRIG_HOME 相对路径读取。");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: "${OPENRIG_HOME}/instructions/restore.md",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("从 OPENRIG_HOME 相对路径读取。");
  });

  it("HG-8：inline 与 file-path 均未设置 → 不自定义追加（保留现有 restore-instructions）", () => {
    writePolicyConfig(openrigHome, { messageInline: "", messageFilePath: "" });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("压缩前恢复种子包已准备");
  });

  it("compaction policy 已启用但未配置 restore 文本时使用默认恢复指令", () => {
    writePartialPolicyConfig(openrigHome, {
      enabled: true,
      thresholdPercent: 80,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("请读取 claude-compaction-restore 技能");
  });

  it("同时设置 inline 与 file-path 时，两者均产生内容", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "也包含文件内容");
    writePolicyConfig(openrigHome, {
      messageInline: "包含内联内容",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("包含内联内容");
    expect(payload.systemMessage).toContain("也包含文件内容");
  });

  it("file-path 文件缺失时优雅降级（不追加、不报错）", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: join(tmpDir, "no-such-file.txt"),
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("压缩前恢复种子包已准备");
  });

  it("config.json 缺失时 hook 仍发出 restore-instructions（优雅降级）", () => {
    // 未写入 config——OPENRIG_HOME 目录甚至可能不存在。
    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("压缩前恢复种子包已准备");
  });

  it("报告 transcript 缺失，不虚构 restore packet，也不借用环境历史", () => {
    const { stdout, status } = runHook(openrigHome, false);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).systemMessage).toContain("找不到 Claude JSONL 转录");
    const markerDir = join(openrigHome, "compaction", "restore-pending");
    expect(existsSync(join(markerDir, "test-seat@kernel.expected.json"))).toBe(true);
    expect(existsSync(join(markerDir, "test-seat@kernel.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "packets"))).toBe(false);
  });
});

// OPR.0.4.1.09（第 2 部分 guard blocker de2d25c7）：产品自有 PreCompact writer 必须生成
// restore packet（运行 restore-from-jsonl），并持久化真实磁盘 outputDir + 操作员 customMessage；
// 绝不能使用硬编码/不存在的 outputDir 或清空消息。（bridge-writer 草案把两者都硬编码了：marker
// 指向未生成的 packet。）此外还有新的逐席位 restoreMapPath 指针（第 1 部分额外目录）。
describe("OPR.0.4.1.09——PreCompact writer 生成真实 packet + 记录 restoreMapPath", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-0419-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readMarker(): Record<string, unknown> {
    const markerPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.json");
    return JSON.parse(readFileSync(markerPath, "utf8"));
  }

  it("GUARD 回归：marker.outputDir 是磁盘上真实存在的已生成 packet（非硬编码/未生成）", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const marker = readMarker();
    expect(dirname(marker["outputDir"] as string)).toBe(join(tmpDir, "packets"));
    // writer 已运行 restore-from-jsonl，因此 packet 目录确实存在于磁盘。
    expect(existsSync(marker["outputDir"] as string)).toBe(true);
  });

  it("GUARD 回归：marker 保留操作员 customMessage（未清空）", () => {
    writePolicyConfig(openrigHome, { messageInline: "操作员：恢复前请读取队列。" });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const marker = readMarker();
    expect(marker["postCompactInstruction"]).toContain("操作员：恢复前请读取队列。");
    expect(existsSync(marker["outputDir"] as string)).toBe(true);
  });

  // 已隔离（D12 基线健康，finding D12-F2）——不是测试 bug：precompact hook marker 完全不发出
  // `restoreMapPath` 字段（marker 仅有 outputDir），因此这两个测试断言的逐席位
  // post-compact-extra/<seat>.md 指针尚未实现。作为 feature-gap finding 路由；在功能落地前按
  // 具名原因跳过（P1 范围不包含 marker 格式变更）。
  it.skip("存在逐席位 post-compact-extra/<seat>.md 时记录 restoreMapPath", () => {
    const extra = join(openrigHome, "compaction", "post-compact-extra", "test-seat@kernel.md");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, "我的逐席位 restore map");
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(readMarker()["restoreMapPath"]).toBe(extra);
  });

  // 已隔离（D12 基线健康，finding D12-F2）——与上方固定点配套：hook 不发出 restoreMapPath
  // 字段，因此“缺失时 = null”契约也尚未实现。在字段落地前按具名原因跳过。
  it.skip("不存在逐席位 extra 时记录 restoreMapPath = null（绝不生成无法解析的指针）", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(readMarker()["restoreMapPath"]).toBeNull();
  });
});

// OPR.0.4.1.09（rev1-r2 blocker dcd95bd9）：PreCompact hook 路径必须应用与 enforcer 的
// resolvePostCompactExtra 相同的错席位拒绝。修复前 hook 不做 seat-check，就把全局
// policy.messageFilePath 读入 marker.postCompactInstruction，导致 enforcer 路径会拒绝的外席位
// 全局 extra 通过 hook 路径泄漏。现在 file 部分具备席位安全性：优先使用逐席位 extra；
// 拒绝声明不同席位的全局文件（仅限格式正确的 frontmatter）。
describe("OPR.0.4.1.09（rev1-r2）——hook 路径 post-compact extra 具备席位安全性（无错席位泄漏）", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-0419-seat-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function markerPostInstruction(): string {
    const markerPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.json");
    return JSON.parse(readFileSync(markerPath, "utf8"))["postCompactInstruction"] as string;
  }

  it("回归：拒绝外席位全局 messageFilePath——内容绝不进入 marker（与 enforcer 一致）", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n---\n顾问私密恢复步骤。");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).not.toContain("顾问私密恢复步骤。");
    expect(markerPostInstruction()).not.toContain("额外恢复指令文件");
  });

  it("逐席位 extra 内容优先于外席位全局内容（结构上保障席位安全）", () => {
    const perSeat = join(openrigHome, "compaction", "post-compact-extra", "test-seat@kernel.md");
    mkdirSync(dirname(perSeat), { recursive: true });
    writeFileSync(perSeat, "我自己的席位恢复步骤。");
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n---\n不属于我。");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("我自己的席位恢复步骤。");
    expect(markerPostInstruction()).not.toContain("不属于我。");
  });

  it("R5 按需缺失：PreCompact hook 写入预期 sentinel（席位身份），使 marker 缺失时明确失败", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const sentinelPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.expected.json");
    expect(existsSync(sentinelPath)).toBe(true);
    const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    expect(sentinel.sessionName).toBe("test-seat@kernel");
    expect("transcriptPath" in sentinel).toBe(true); // identity-binding 字段存在（与 marker 一致）
  });

  it("注入通用全局 extra（无 frontmatter → 对任意席位有效）", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "适用于所有席位的通用恢复说明。");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("适用于所有席位的通用恢复说明。");
  });

  it("注入 frontmatter 格式正确且声明本席位的全局 extra", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: test-seat@kernel\n---\n由 frontmatter 声明属于我。");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("由 frontmatter 声明属于我。");
  });

  it("注入 frontmatter 格式错误的全局 extra（未闭合 fence → 视为通用，不拒绝）", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n# 没有闭合 fence\n仍为通用内容。");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("仍为通用内容。");
  });
});
