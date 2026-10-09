#!/usr/bin/env node
"use strict";

// Refocus 有意设计为长会话功能，而非启动引导。Claude 观测转录增长；两个运行时都观测
// 各自准确的 PostCompact 事件；二者都接受显式请求。Stop/PostCompact 保留到期状态；
// 上下文只在 UserPromptSubmit 边界消费，因为此时 harness 才能真正投递 additionalContext。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULT_THRESHOLD = 2_600_000;
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

function runtime() {
  const index = process.argv.indexOf("--runtime");
  return index >= 0 && process.argv[index + 1] === "codex" ? "codex" : "claude";
}

function enabled(value, fallback = true) {
  if (value === undefined || value === "") return fallback;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
}

function threshold() {
  const value = Number(process.env.OPENRIG_REFOCUS_BYTES || DEFAULT_THRESHOLD);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD;
}

const readStdin = () => new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", () => resolve(""));
});

function readConfiguredContent(home) {
  const contentRef = process.env.OPENRIG_REFOCUS_CONTENT_REF || "";
  if (contentRef) {
    const result = spawnSync("rig", ["context", "get", contentRef], {
      encoding: "utf8",
      env: process.env,
      timeout: 2_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error && result.status === 0 && result.stdout.trim()) {
      return { content: result.stdout, contentRef, failure: null };
    }
    const failure = result.error?.message
      || result.stderr?.trim()
      || result.stdout?.trim()
      || `rig context get 已退出，状态：${result.status ?? "无状态"}`;
    return {
      content: null,
      contentRef,
      failure: String(failure).replace(/\s+/g, " ").trim(),
    };
  }

  const configuredFile = [
    process.env.OPENRIG_REFOCUS_CONTENT_FILE,
    path.join(home, "refocus", "REFOCUS.md"),
  ].filter(Boolean).find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (configuredFile) {
    try {
      const content = fs.readFileSync(configuredFile, "utf8").trim();
      if (content) return { content, contentRef: "", failure: null };
    } catch {}
  }

  const shippedDefault = path.resolve(__dirname, "../../skills/refocusing/references/refocus.md");
  try {
    const content = fs.readFileSync(shippedDefault, "utf8").trim();
    if (content) return { content, contentRef: "", failure: null };
  } catch {}

  return {
    content: [
      "1. 用户真正想得到什么？不要复述当前任务，要说明结果。",
      "2. 你此刻所做的事是否推动了该结果？如果无法说明用户会得到什么，请停下并直说。",
      "3. 哪些结论是在未打开文件或未实际运行对象的情况下得出的？",
    ].join("\n"),
    contentRef: "",
    failure: null,
  };
}

// 实时席位没有 OPENRIG_REFOCUS_WORK_NODE，因此过去即使后台服务已经能指出席位的类型化接力棒，
// 追踪仍报告工作节点未解析；现在向后台服务查询。显式变量始终优先并短路调用；此处任何失败都
// 返回 null，并保留原有缺口行，因为拒绝回答才是正确行为，猜测工作节点会静默重定向整条追踪。
function deriveWorkStart() {
  if (process.env.OPENRIG_REFOCUS_WORK_NODE) return process.env.OPENRIG_REFOCUS_WORK_NODE;
  const result = spawnSync("rig", ["queue", "whoami", "--json"], {
    encoding: "utf8",
    env: process.env,
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.trim()) return null;
  try {
    const workNodePath = JSON.parse(result.stdout)?.currentWork?.workNodePath;
    return typeof workNodePath === "string" && workNodePath ? workNodePath : null;
  } catch {
    return null;
  }
}

function renderTrace() {
  const script = path.resolve(__dirname, "../../skills/refocusing/scripts/trace-to-root.py");
  const args = [
    script,
    "--trees", process.env.OPENRIG_REFOCUS_TREES || "both",
    "--depth", process.env.OPENRIG_REFOCUS_DEPTH || "light",
  ];
  if (process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE) {
    args.push("--topology-start", process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE);
  }
  const workStart = deriveWorkStart();
  if (workStart) {
    args.push("--work-start", workStart);
  }
  const result = spawnSync(process.env.PYTHON || "python3", args, {
    encoding: "utf8",
    env: process.env,
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  const reason = result.error?.message || result.stderr?.trim() || `追踪已退出，状态：${result.status ?? "无状态"}`;
  return `追踪缺口——${String(reason).replace(/\s+/g, " ").trim()}`;
}

(async () => {
  if (!enabled(process.env.OPENRIG_REFOCUS_ENABLED)) process.exit(0);

  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}") || {}; } catch {}
  const event = input.hook_event_name || "UserPromptSubmit";
  const harness = runtime();

  // 新会话引导由默认 onboarding 包负责。即使手动调用钩子，此处也必须空操作，避免过期注册
  // 损坏全局安装。
  if (event === "SessionStart") process.exit(0);

  const seat = process.env.OPENRIG_SESSION_NAME || "unknown-seat";
  const home = process.env.OPENRIG_HOME || path.join(process.env.HOME || "/tmp", ".openrig");
  const transcriptPath = input.transcript_path || input.transcriptPath || "";
  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch {}

  const stateDir = path.join(home, "refocus");

  // OPR.0.5.6.25——状态以占位者而非席位为键。以席位为键的文件会让新占位者继承前任的
  // lastBytes（恰好在发生换代的席位上永久零增长）及其待投递状态。身份由钩子族自身字段派生；
  // 受守卫表达式绝不会对缺失值求 basename。旧版 `${seat}.json` 永远不读取、导入或重写，
  // 只保留在磁盘上作为诊断/迁移材料。
  const sanitize = (raw) => String(raw).replace(/[^A-Za-z0-9@._-]/g, "_");
  const seatKey = sanitize(seat);
  const firstString = (...vals) => {
    for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  };
  const transcriptIdentity = input.transcript_path
    ? path.basename(input.transcript_path, ".jsonl")
    : input.transcriptPath
      ? path.basename(input.transcriptPath, ".jsonl")
      : null;
  const identity = firstString(input.session_id, input.sessionId, transcriptIdentity);

  // 有界、确定且抗冲突的键：发生有损清理或截断时，追加清理前完整身份的稳定短哈希，
  // 使不同身份仍保持区分，并确保所有路径留在状态目录内。
  const KEY_MAX = 64;
  const keyFor = (raw) => {
    const bounded = sanitize(raw).slice(0, KEY_MAX);
    if (bounded === String(raw)) return bounded;
    const suffix = crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 8);
    return `${bounded}__${suffix}`;
  };

  // 无身份诊断哨兵：只表示 ACTIVE-EPISODE，绝不代表基线、增长声明、待处理或触发。
  // "#" 不在键字符类中，因此任何派生身份路径都不会与它冲突。第一次缺失事件会记录并呈现
  // 一次，重复事件保持静默；有效身份事件会清除标记，使后续独立回合可再次呈现一次。
  const sentinelFile = path.join(stateDir, `${seatKey}#no-identity-sentinel.json`);
  if (identity === null) {
    let sentinel = null;
    try { sentinel = JSON.parse(fs.readFileSync(sentinelFile, "utf8")); } catch {}
    if (!sentinel || sentinel.activeEpisode !== true) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(sentinelFile, JSON.stringify({ activeEpisode: true, recordedAt: new Date().toISOString() }));
      } catch {}
      process.stderr.write(`refocus：席位 ${seat} 没有会话身份或转录路径——本回合无法测量\n`);
    }
    process.exit(0);
  }
  try {
    const sentinel = JSON.parse(fs.readFileSync(sentinelFile, "utf8"));
    if (sentinel && sentinel.activeEpisode === true) {
      fs.writeFileSync(sentinelFile, JSON.stringify({ activeEpisode: false, clearedAt: new Date().toISOString() }));
    }
  } catch {}

  const stateFile = path.join(stateDir, `${seatKey}__${keyFor(identity)}.json`);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")) || null; } catch {}
  const persist = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };

  if (state === null) {
    // 当前占位者的首次观测：以其自身当前大小为基线，从此处开始累计增长，不继承任何内容。
    // 读数为零表示转录缺失或不可读，即监测数据缺失而非基线；只有真实测得零时才记录零。
    state = { lastBytes: size, baselineAt: new Date().toISOString() };
    persist();
  } else if (size > 0 && size < Number(state.lastBytes || 0)) {
    // 文件缩小时，在计算到期状态前清除 pending 并重置基线。重置本身不发出 refocus，过期
    // pending 也绝不会穿过重置进入投递。每个重置回合只提示一次：重置时刻即去重点
    //（之后 lastBytes === size），标记写入状态。
    delete state.pendingOn;
    delete state.pendingAt;
    state.lastReset = { at: new Date().toISOString(), fromBytes: Number(state.lastBytes || 0), toBytes: size };
    state.lastBytes = size;
    persist();
    process.stderr.write(`refocus：席位 ${seat} 的转录已缩小——已重置基线并清除待处理状态\n`);
  }

  const lastBytes = Number(state.lastBytes || 0);
  const grown = size > lastBytes ? size - lastBytes : 0;
  const onDemand = enabled(process.env.OPENRIG_REFOCUS_NOW, false);
  const thresholdDue = harness === "claude" && grown >= threshold();
  const due = onDemand
    || event === "PostCompact"
    || Boolean(state.pendingOn)
    || thresholdDue;
  if (!due) process.exit(0);

  if (event !== "UserPromptSubmit") {
    if (event === "PostCompact" || !state.pendingOn) state.pendingOn = event;
    state.pendingAt ||= new Date().toISOString();
    persist();
    process.exit(0);
  }

  // 解析上下文 ref 前先运行公共追踪。除保持内容阶梯不变外，这还让 `rig context get` 成为
  // 最后一次解析器调用，并保留既有可观测 ref 契约。
  const trace = renderTrace();
  const configured = readConfiguredContent(home);
  const why = onDemand
    ? "按需触发"
    : state.pendingOn === "PostCompact"
      ? "刚刚完成压缩——你掌握的信息可能有损"
      : `距上次重新聚焦已新增 ${Math.round(grown / 1e6 * 10) / 10}MB 工作记录`;

  const body = configured.failure
    ? [
        `重新聚焦内容引用失败：${configured.contentRef}——${configured.failure}`,
        "",
        "配置的来源失败；本轮请使用下方随附默认内容。",
        "",
        "",
      ]
    : configured.contentRef
      ? [`重新聚焦内容来源：OPENRIG_REFOCUS_CONTENT_REF=${configured.contentRef}`, "", configured.content]
      : [configured.content];

  // ref 失败时仍必须携带通用默认内容。直接读取随附文件，避免递归经过失败的 ref。
  if (configured.failure) {
    try {
      body[4] = fs.readFileSync(
        path.resolve(__dirname, "../../skills/refocusing/references/refocus.md"),
        "utf8",
      ).trim();
    } catch {
      body[4] = "1. 用户真正想得到什么？\n2. 当前操作是否推动了该结果？\n3. 哪项结论尚未在来源处核验？";
    }
  }

  const payload = (configured.failure
    ? [...body, "", trace]
    : [
        `重新聚焦（${why}）。下一步操作前，请简短、明确地回答：`,
        "",
        trace,
        "",
        ...body,
      ]).join("\n");
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: payload,
    },
  });
  process.stdout.write(output, () => {
    if (size > 0) state.lastBytes = size;
    state.firedAt = new Date().toISOString();
    state.firedOn = event;
    delete state.pendingOn;
    delete state.pendingAt;
    persist();
  });
})();
