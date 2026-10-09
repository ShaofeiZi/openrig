#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillRoot = path.resolve(new URL("..", import.meta.url).pathname);
const restoreScript = path.join(skillRoot, "scripts", "restore-from-jsonl.mjs");
// P6(C) 可注入输出根目录：包基础目录默认使用共享的 /tmp/claude-compaction-restore
//（生产环境）；设置隔离环境变量 OPENRIG_COMPACTION_OUT_ROOT 后改为逐次运行隔离，使使用
// 同一注入时钟与 sessionId 的并发写入器不再争用同一个 `${sessionId}-${stamp}` 目录。
// 与可注入时钟接缝 OPENRIG_TEST_CLOCK_NOW 对称；为空/缺失时使用 /tmp。
const outRoot = process.env.OPENRIG_COMPACTION_OUT_ROOT || "/tmp/claude-compaction-restore";
const defaultRestoreInstruction =
  "请读取 claude-compaction-restore 技能，并遵循其中的“如果你刚刚完成压缩”流程。";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getOpenRigHome() {
  return process.env.OPENRIG_HOME || process.env.RIGGED_HOME || path.join(os.homedir(), ".openrig");
}

// A3-R3 可注入时钟（slice 51-01）：marker.createdAt 默认使用真实墙上时钟；设置共享隔离
// 环境变量 OPENRIG_TEST_CLOCK_NOW（ISO 时刻）后改为确定性时间。为空/缺失时使用生产实时。
function nowIso() {
  const injected = process.env.OPENRIG_TEST_CLOCK_NOW;
  return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
}

function expandInstructionPath(filePath) {
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  if (filePath.startsWith("${OPENRIG_HOME}/")) {
    return path.join(getOpenRigHome(), filePath.slice("${OPENRIG_HOME}/".length));
  }
  if (filePath.startsWith("$OPENRIG_HOME/")) {
    return path.join(getOpenRigHome(), filePath.slice("$OPENRIG_HOME/".length));
  }
  return filePath;
}

function readInstructionFile(filePath) {
  const expanded = expandInstructionPath(filePath);
  if (!fs.existsSync(expanded)) return "";
  return fs.readFileSync(expanded, "utf8");
}

// OPR.0.4.1.09 / R5 标记生命周期（标记内含外来内容这一侧）：钩子路径必须执行与后台服务
// enforcer 的 resolvePostCompactExtra 相同的席位检查（rev1-r2 dcd95bd9），否则外来席位的
// 全局 messageFilePath 会泄漏进当前席位标记。解析格式正确、以 `---` 开头的 frontmatter，
// 获取声明的席位（target_seat/seat/session）；绝不扫描正文；围栏损坏/缺失时视为通用内容，
// 对任意席位有效。正则与 enforcer 逐字节镜像。
function declaredSeatOf(content) {
  const fm = /^\s*---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return null;
  const m = /^[ \t]*(?:target[_-]?seat|seat|session(?:[_-]?name)?)[ \t]*:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/im.exec(fm[1]);
  return m ? m[1].trim() : null;
}

function sanitizeSeat(value) {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

// 为当前席位解析压缩后附加内容（镜像 enforcer）：(1) 优先使用逐席位
// compaction/post-compact-extra/<seat>.md，不可能跨席位污染；(2) 仅当全局文件未声明其他席位时
// 才回退到全局文件，错误席位的全局文件会被拒绝。通用、未声明、已配置但缺失的情况仍允许。
// 返回待读路径；没有适用于当前席位的有效内容时返回 null。
function resolveSeatSafeExtraPath(globalFilePathRaw) {
  const rawSeat = process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || "";
  const seatKey = rawSeat ? sanitizeSeat(rawSeat) : "";
  if (seatKey) {
    const perSeatPath = path.join(getOpenRigHome(), "compaction", "post-compact-extra", `${seatKey}.md`);
    if (fs.existsSync(perSeatPath)) {
      const declared = declaredSeatOf(fs.readFileSync(perSeatPath, "utf8"));
      if (declared && sanitizeSeat(declared) !== seatKey) return null; // 错误席位的逐席位文件。
      return perSeatPath;
    }
  }
  const trimmed = (globalFilePathRaw || "").trim();
  if (!trimmed) return null;
  const expanded = expandInstructionPath(trimmed);
  // 已配置但缺失：保留路径。缺失文件不可能造成错误席位泄漏；readInstructionFile 返回 ""，
  // 因此不会追加内容。
  if (!fs.existsSync(expanded)) return trimmed;
  const declared = declaredSeatOf(fs.readFileSync(expanded, "utf8"));
  if (declared && sanitizeSeat(declared) !== seatKey) return null; // 拒绝外来席位的全局文件。
  return trimmed;
}

function sessionKey(input) {
  const raw = [
    process.env.OPENRIG_SESSION_NAME,
    process.env.RIGGED_SESSION_NAME,
    input.session_id,
    input.sessionId,
    input.session_name,
    input.sessionName,
    input.transcript_path ? path.basename(input.transcript_path, ".jsonl") : "",
  ].find((value) => typeof value === "string" && value.trim().length > 0) || "unknown-session";
  return raw.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

function pendingMarkerPath(input) {
  return path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.json`);
}

// R5 按需检测缺失：先写入轻量 EXPECTED 哨兵，再生成包和写入标记；哨兵携带与标记相同的
// 身份绑定。存在哨兵却没有标记时，桥才能明确报告包缺失（钩子中途退出/写入失败）；
// 策略关闭 = 无钩子 = 无哨兵 = 静默。
function writeExpectedSentinel(input) {
  const p = path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.expected.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    version: 1,
    sessionName: process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || null,
    sessionId: input.session_id || input.sessionId || null,
    transcriptPath: input.transcript_path || null,
    createdAt: nowIso(),
  }, null, 2)}\n`, "utf8");
}

function writePendingRestoreMarker(input, parsed, restoreInstruction, customMessage) {
  const markerPath = pendingMarkerPath(input);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const payload = {
    version: 1,
    createdAt: nowIso(),
    sessionName: process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || null,
    sessionId: input.session_id || input.sessionId || null,
    transcriptPath: input.transcript_path || null,
    cwd: input.cwd || null,
    outputDir: parsed.outputDir,
    restoreInstruction,
    postCompactInstruction: customMessage || "",
    expectedAck: "restored from packet at <path>; resumed at step <X>",
    deliveredAt: null,
    deliveryCount: 0,
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return markerPath;
}

// Slice 27——直接读取 OpenRig 配置，不依赖后台服务 HTTP，因此后台服务未运行或当前进程
// 无法访问时钩子仍可工作。配置缺失、格式错误或未设置策略时，相应字段返回 ""。若策略已启用
// 但尚未写入恢复文本，则使用 OpenRig 默认指令加载规范恢复技能。同时配置内联指令和文件路径时，
// 两者都会包含。
function readClaudeCompactionMessage() {
  const configPath = path.join(getOpenRigHome(), "config.json");
  let inline = "";
  let filePath = "";
  let inlineConfigured = false;
  let filePathConfigured = false;
  let policyEnabled = false;
  try {
    if (!fs.existsSync(configPath)) return "";
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const policy = parsed?.policies?.claudeCompaction;
    if (policy && typeof policy === "object") {
      policyEnabled = policy.enabled === true;
      if (typeof policy.messageInline === "string") {
        inlineConfigured = true;
        inline = policy.messageInline;
      }
      if (typeof policy.messageFilePath === "string") {
        filePathConfigured = true;
        filePath = policy.messageFilePath;
      }
    }
  } catch {
    return "";
  }

  const parts = [];
  if (inline && inline.length > 0) {
    parts.push(`内联恢复指令：\n${inline}`);
  }
  if (filePath && filePath.length > 0) {
    // R5 席位检查：解析为逐席位附加文件或席位安全的全局文件；外来席位的全局文件解析为 null，
    // 绝不注入当前标记。
    const resolved = resolveSeatSafeExtraPath(filePath);
    if (resolved) {
      try {
        const fileText = readInstructionFile(resolved);
        if (fileText) {
          parts.push(`附加恢复指令文件（${resolved}）：\n${fileText}`);
        }
      } catch {
        // 保留已有内联指令；附加文件不可读时静默降级。
      }
    }
  }
  if (parts.length > 0) return parts.join("\n\n");
  if (policyEnabled && !inlineConfigured && !filePathConfigured) {
    return defaultRestoreInstruction;
  }
  return "";
}

function buildSystemMessage(restoreInstruction, customMessage) {
  if (!customMessage) return restoreInstruction;
  return `${restoreInstruction}\n\n--- 操作员配置的压缩后恢复指令 ---\n${customMessage}`;
}

try {
  // Slice 51-01 附加条款（泄漏可见性，review-r1 升级）：nowIso() 读取
  // OPENRIG_TEST_CLOCK_NOW，使测试中的 createdAt 确定；但该变量若泄漏进真实席位，会静默冻结
  // 生产 createdAt。启用时在 stderr 明确提示，使任何泄漏都在席位日志中可见；缺失时保持静默
  //（生产路径）。此文本必须与 stub-runner.ts 中的 STUB_CLOCK_ANNOUNCEMENT 逐字节一致。
  if (typeof process.env.OPENRIG_TEST_CLOCK_NOW === "string" && process.env.OPENRIG_TEST_CLOCK_NOW.trim().length > 0) {
    process.stderr.write("OPENRIG_TEST_CLOCK_NOW active — timestamps are injected\n");
  }
  const input = readHookInput();
  writeExpectedSentinel(input); // R5: sentinel FIRST, before the packet + marker (catches hook-died-partway)
  const args = [restoreScript, "--out", outRoot, "--json"];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.transcript_path && input.transcript_path.endsWith(".jsonl") && fs.existsSync(input.transcript_path)) {
    args.push(input.transcript_path);
  }

  const customMessage = readClaudeCompactionMessage();

  const result = spawnSync("node", args, { encoding: "utf8" });
  if (result.status !== 0) {
  const baseFailure = `Claude 压缩恢复包生成失败：${(result.stderr || result.stdout || "未知错误").trim()}。压缩后请加载 claude-compaction-restore 技能，并手动运行 restore-from-jsonl。`;
    emit({
      continue: true,
      systemMessage: buildSystemMessage(baseFailure, customMessage),
    });
    process.exit(0);
  }

  const parsed = JSON.parse(result.stdout);
  const baseRestore = `压缩前恢复种子包已准备在 ${parsed.outputDir}。此钩子输出仅是信息。压缩后，OpenRig 稍后可能发送普通用户消息，要求你从此恢复包恢复；请把那条后续普通用户消息视为操作请求。恢复流程：加载并阅读 claude-compaction-restore 技能，需要时自行运行 "node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json"，阅读生成的 restore-instructions.md 和 touched-files.md，识别记忆中重要的文件并完整阅读，再在开始实际工作前完整阅读根目录/as-built/codemap 文档，最后回复 "restored from packet at <path>; resumed at step <X>" 并列出已完整阅读的文件。任何步骤失败都要明确报告。`;
  const markerPath = writePendingRestoreMarker(input, parsed, baseRestore, customMessage);
  emit({
    continue: true,
    systemMessage: buildSystemMessage(`${baseRestore} OpenRig 还在 ${markerPath} 写入了待恢复标记。`, customMessage),
  });
} catch (error) {
  emit({
    continue: true,
    systemMessage: `Claude 压缩恢复钩子出错：${error.message}。压缩后请加载 claude-compaction-restore 技能，并手动运行 restore-from-jsonl。`,
  });
}
