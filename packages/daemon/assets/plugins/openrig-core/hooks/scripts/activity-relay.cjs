#!/usr/bin/env node
"use strict";

// OpenRig activity-relay 钩子脚本。
// 从 stdin 读取钩子事件 payload，规范化后 POST 到 OpenRig 后台服务的 /api/activity/hooks
// 端点，用于实时 UI 席位状态。仅尽力而为：1.5 秒超时，吞掉错误，绝不阻塞智能体循环。
//
// 必需环境变量（OpenRig 后台服务启动智能体时注入）：
//   OPENRIG_SESSION_NAME 或 RIGGED_SESSION_NAME  - tmux 会话 id
//   OPENRIG_NODE_ID      或 RIGGED_NODE_ID       - 工作组拓扑中的节点 id
//   OPENRIG_RUNTIME      或 RIGGED_RUNTIME       - "claude-code" | "codex" 等
//   OPENRIG_URL          或 RIGGED_URL           - 后台服务基础 URL
//   OPENRIG_ACTIVITY_HOOK_TOKEN 或 RIGGED_ACTIVITY_HOOK_TOKEN - bearer 鉴权

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

function buildOpenRigPayload(providerPayload, env = process.env, now = () => new Date()) {
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  const hookEvent = firstString(
    providerPayload.hookEvent,
    providerPayload.hookEventName,
    providerPayload.hook_event_name,
    providerPayload.event,
    providerPayload.eventName
  );

  if ((!sessionName && !nodeId) || !runtime || !hookEvent) return null;

  const subtype = firstString(
    providerPayload.subtype,
    providerPayload.notification_type,
    providerPayload.notificationType,
    providerPayload.tool_name,
    providerPayload.toolName,
    providerPayload.source,
    providerPayload.matcher
  );

  return {
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    subtype,
    occurredAt: now().toISOString(),
  };
}

// OPR.0.4.3.28 B1+B3——解析摄取基础 URL 与 token，而不依赖操作员预先把
// OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN 写入 shell：
//   1. 环境变量 OPENRIG_URL/token（不变的快速路径）。
//   2. B1：URL 缺失时，根据 OPENRIG_HOST + OPENRIG_PORT 合成基础 URL；两者都存在于
//      已启动席位的环境中。
//   3. B3：文件发现——对于冻结进程环境中缺少活动变量的协调/恢复席位，从
//      OPENRIG_HOME/activity-endpoint.json（默认 ~/.openrig）读取 {baseUrl, token}。
//      后台服务启动时写入此文件。身份（session/node/runtime）仍来自环境变量，而先前启动后
//      再协调的席位会从 tmux 会话环境继承这些变量。
function resolveEndpoint(env = process.env) {
  let baseUrl = firstString(env.OPENRIG_URL, env.RIGGED_URL);
  let token = firstString(env.OPENRIG_ACTIVITY_HOOK_TOKEN, env.RIGGED_ACTIVITY_HOOK_TOKEN);

  if (!baseUrl) {
    const port = firstString(env.OPENRIG_PORT, env.RIGGED_PORT);
    if (port) {
      const host = firstString(env.OPENRIG_HOST, env.RIGGED_HOST) || "127.0.0.1";
      baseUrl = `http://${host}:${port}`;
    }
  }

  if (!baseUrl || !token) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const home = firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0) baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string" && parsed.token.length > 0) token = parsed.token;
    } catch {
      // 缺失或格式错误——调用方会在下方安全地执行空操作。
    }
  }

  return { baseUrl, token };
}

async function postHookPayload(payload, env = process.env) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token || !payload || typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(new URL("/api/activity/hooks", baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // OpenRig 不可用时，provider 钩子不得阻塞智能体循环。
  } finally {
    clearTimeout(timeout);
  }
}

function buildSessionIdentityPayload(providerPayload, env = process.env, now = () => new Date()) {
  if (!providerPayload || typeof providerPayload !== "object") return null;
  const hookEvent = firstString(
    providerPayload.hookEvent, providerPayload.hookEventName,
    providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName
  );
  if (!hookEvent || hookEvent.toLowerCase() !== "sessionstart") return null;

  const sessionId = firstString(providerPayload.session_id, providerPayload.sessionId);
  if (!sessionId) return null;

  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);

  if ((!sessionName && !nodeId) || !runtime) return null;

  return {
    eventFamily: "session_identity",
    sessionName,
    nodeId,
    runtime,
    hookEvent,
    sessionId,
    occurredAt: now().toISOString(),
  };
}

async function main() {
  const providerPayload = parseJson(await readStdin());
  const payload = buildOpenRigPayload(providerPayload);
  await postHookPayload(payload);

  const identityPayload = buildSessionIdentityPayload(providerPayload, process.env);
  if (identityPayload) {
    await postHookPayload(identityPayload);
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildOpenRigPayload,
  buildSessionIdentityPayload,
  parseJson,
  postHookPayload,
  resolveEndpoint,
};
