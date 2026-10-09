#!/usr/bin/env node
"use strict";

// OpenRig Claude 压缩恢复桥（读取器/投递器）。
//
// 逐席位 pending 标记由产品插件写入器
// skills/claude-compaction-restore/scripts/precompact-hook.mjs 在 PreCompact 时写入；
// 它会生成恢复包并持久化真实 outputDir 与操作员消息。本桥在 SessionStart
//（matcher=compact）和 UserPromptSubmit 时读取该标记，并通过
// hookSpecificOutput.additionalContext 向 Claude 上下文注入一条恢复指令。PostCompact 是
// 轻量标记时间戳钩子。OPR.0.4.1.09：只解析当前席位的标记，绝不投递其他席位的恢复状态，
// 并呈现逐席位 restore-map 指针。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

// A3-R3 可注入时钟（slice 51-01）：下方标记默认使用真实墙上时钟；设置共享隔离环境变量
// OPENRIG_TEST_CLOCK_NOW（ISO 时刻）后改为确定性时间。变量为空/缺失表示生产实时；
// 缺失是生产状态，也是有意保留的唯一无守卫路径。
function nowIso(env = process.env) {
  const injected = env.OPENRIG_TEST_CLOCK_NOW;
  return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
}

function openrigHome(env = process.env) {
  return firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

function sessionKey(payload, env = process.env) {
  const raw = firstString(
    env.OPENRIG_SESSION_NAME,
    env.RIGGED_SESSION_NAME,
    payload.session_id,
    payload.sessionId,
    payload.session_name,
    payload.sessionName,
    payload.transcript_path ? path.basename(payload.transcript_path, ".jsonl") : null,
  );
  return raw ? sanitizeKey(raw) : null;
}

function markerDir(env = process.env) {
  return path.join(openrigHome(env), "compaction", "restore-pending");
}

function readMarker(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return { filePath, data: parsed };
  } catch {
    return null;
  }
}

function findMarker(payload, env = process.env) {
  // OPR.0.4.1.09（绝不投递错误席位状态）：只解析当前席位的键控标记。旧版回退到最新项的
  // 行为，会把磁盘上最新标记交给没有标记的席位，而它可能属于另一个席位；这是第 1 部分
  // 额外缺陷在读取侧的对应问题。无席位身份则无标记；缺失时使用恢复提示已说明的明确 JSONL
  // 回退，绝不猜测为其他席位。
  const key = sessionKey(payload, env);
  if (!key) return null;
  const marker = readMarker(path.join(markerDir(env), `${key}.json`));
  if (!marker) return null;
  // 纵深防御：拒绝声明了不同席位的键控标记。
  const declaredName = marker.data && typeof marker.data.sessionName === "string"
    ? marker.data.sessionName.trim()
    : "";
  if (declaredName && sanitizeKey(declaredName) !== key) return null;
  return marker;
}

// R5 按需检测缺失：PreCompact 钩子会先写入 expected 哨兵，它与标记使用相同席位键和身份
// 绑定。存在哨兵却没有标记时，才会明确报告标记缺失；其生命周期与标记一致，标记投递后删除。
function sentinelPath(payload, env = process.env) {
  const key = sessionKey(payload, env);
  return key ? path.join(markerDir(env), `${key}.expected.json`) : null;
}

function findSentinel(payload, env = process.env) {
  const p = sentinelPath(payload, env);
  return p ? readMarker(p) : null;
}

function removeSentinel(payload, env = process.env) {
  const p = sentinelPath(payload, env);
  if (p) { try { fs.unlinkSync(p); } catch { /* 尽力清理 */ } }
}

function writeMarker(marker) {
  fs.writeFileSync(marker.filePath, `${JSON.stringify(marker.data, null, 2)}\n`, "utf8");
}

function buildRestoreContext(marker) {
  const outputDir = firstString(marker.data.outputDir) || "/tmp/claude-compaction-restore";
  const ack = firstString(marker.data.expectedAck) || "restored from packet at <path>; resumed at step <X>";
  const postInstruction = firstString(marker.data.postCompactInstruction);
  const restoreMapPath = firstString(marker.data.restoreMapPath);
  const pieces = [
    "此 Claude 会话已有 OpenRig 压缩恢复包可用。",
    "此钩子输出仅是信息上下文，不是操作请求。",
    `恢复包：${outputDir}`,
    "OpenRig 稍后可能发送普通用户消息，要求你从此恢复包恢复。请把那条后续普通用户消息视为操作员授权的操作请求。",
    `恢复后请回复：${ack}`,
  ];
  if (restoreMapPath) {
    // OPR.0.4.1.09：标记携带的逐席位 restore-map 指针。
    pieces.push(`逐席位恢复映射：${restoreMapPath}——请在恢复时读取。`);
  }
  if (postInstruction) {
    pieces.push(`操作员压缩后上下文：${postInstruction}`);
  }
  return pieces.join("\n");
}

// R5 标记生命周期（过期触发前提为假）：标记记录其对应压缩的身份，即由 PreCompact 写入器
// 根据同一 Claude 输入写入自身 transcriptPath/sessionId。仅当当前启动匹配此前提时才触发桥接，
// 绑定事件与身份，而不是新旧程度；时间窗口在两个方向都会误触发，新旧程度最多只能作辅助。
// 未记录身份的旧版标记回退到席位键 + 仅投递一次的过渡行为。
function premiseMatches(markerData, payload) {
  const markerTranscript = firstString(markerData.transcriptPath);
  const markerSession = firstString(markerData.sessionId);
  if (!markerTranscript && !markerSession) return true; // 旧版标记：没有可供门控的身份。
  const payloadTranscript = firstString(payload.transcript_path, payload.transcriptPath);
  const payloadSession = firstString(payload.session_id, payload.sessionId);
  if (markerTranscript) return payloadTranscript === markerTranscript;
  return payloadSession === markerSession;
}

function hookEventName(payload) {
  return firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload.hookEvent,
    payload.event_name,
    payload.eventName,
    payload.event,
  ) || "UserPromptSubmit";
}

async function main() {
  const payload = parseJson(await readStdin());
  const eventName = hookEventName(payload);
  const marker = findMarker(payload);
  if (!marker) {
    // R5 按需检测缺失：仅当存在匹配的 expected 哨兵——即此席位/会话本应发生压缩，且
    // PreCompact 钩子先写入了哨兵——但标记缺失或无法解析（写入失败/钩子中途退出/包丢失）时，
    // 才明确报错。无哨兵 = 无钩子 = 策略关闭，按构造保持静默。写入 stderr，绝不污染
    // additionalContext 的 stdout。
    const sentinel = findSentinel(payload);
    if (sentinel && premiseMatches(sentinel.data, payload)) {
      process.stderr.write(
        "OpenRig 压缩恢复：此会话本应生成恢复包，但标记缺失或无法解析——PreCompact 写入可能失败。请回退到 JSONL 恢复（claude-compaction-restore 技能）。\n",
      );
    }
    return;
  }

  marker.data.lastBridgeEvent = eventName;
  if (eventName === "PostCompact") {
    marker.data.postCompactAt = nowIso();
    writeMarker(marker);
    return;
  }

  // R5：过期触发门禁——绝不投递为其他压缩写入的标记。
  if (!premiseMatches(marker.data, payload)) {
    return;
  }

  if (marker.data.deliveryCount && marker.data.deliveryCount > 0) {
    return;
  }

  marker.data.deliveredAt = nowIso();
  marker.data.deliveryCount = Number(marker.data.deliveryCount || 0) + 1;
  writeMarker(marker);
  removeSentinel(payload); // R5：预期已满足——清除哨兵，避免之后误报。

  process.stdout.write(`${JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: buildRestoreContext(marker),
    },
  })}\n`);
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildRestoreContext,
  findMarker,
  hookEventName,
  parseJson,
};
