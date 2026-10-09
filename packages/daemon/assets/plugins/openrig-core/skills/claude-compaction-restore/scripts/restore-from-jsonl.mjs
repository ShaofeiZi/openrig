#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const TEXT_LIMIT = 4000;
const BASE64_RUN = 800; // 移除至少达到此长度的连续 base64 内容（截图、data URI）。

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

// R3：用紧凑标记替换二进制/base64 payload（data URI、长 base64 串），避免单个截图块
// 把转录撑大到无法分块的程度。
function stripBinary(text) {
  let s = String(text ?? "");
  s = s.replace(/data:([\w.+-]+\/[\w.+-]+)?;base64,[A-Za-z0-9+/=\s]{200,}/g,
    (m, mime) => `[已省略二进制内容：约 ${m.length} 字节${mime ? `，${mime}` : ""}]`);
  s = s.replace(new RegExp(`[A-Za-z0-9+/]{${BASE64_RUN},}={0,2}`, "g"),
    (m) => `[已省略 base64 内容：约 ${m.length} 字节]`);
  return s;
}
const DEFAULT_OUT = "/tmp/claude-compaction-restore";

function parseArgs(argv) {
  const args = {
    jsonl: null,
    out: DEFAULT_OUT,
    cwd: process.cwd(),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--jsonl") args.jsonl = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("-") && !args.jsonl) args.jsonl = arg;
    else throw new Error(`未知参数：${arg}`);
  }

  return args;
}

function readJsonLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse-error", line: index + 1, error: String(error), raw: line };
      }
    });
}

function findLatestJsonl(cwd) {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return null;

  const encoded = cwd ? cwd.replaceAll("/", "-") : null;
  const candidates = [];
  const roots = [];

  if (encoded) {
    const exact = path.join(projectsRoot, encoded);
    if (fs.existsSync(exact)) roots.push(exact);
  }
  roots.push(projectsRoot);

  for (const root of roots) {
    const result = spawnSync("find", [root, "-name", "*.jsonl", "-maxdepth", root === projectsRoot ? "4" : "2"], {
      encoding: "utf8",
    });
    if (result.status !== 0 && !result.stdout) continue;
    for (const file of result.stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const stat = fs.statSync(file);
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // 忽略并发竞态中已删除的转录文件。
      }
    }
    if (candidates.length) break;
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file ?? null;
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "image") return `[image omitted: ${block.source?.media_type ?? "image"}]`;
        if (block?.type === "tool_use") return `[tool_use:${block.name}] ${JSON.stringify(block.input ?? {})}`;
        if (block?.type === "tool_result") return `[tool_result] ${truncate(stripBinary(stringifyContent(block.content)), TEXT_LIMIT)}`;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[…已截断 ${s.length - max} 个字符…]`;
}

function walkStrings(value, acc = []) {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => walkStrings(item, acc));
  return acc;
}

function normalizeFile(candidate, cwd) {
  let file = candidate.trim().replace(/[),.;:'"`\]\}>]+$/g, "").replace(/^[('"`<\[]+/g, "");
  if (!file || file.includes("\n")) return null;
  if (/\.(?:md|mdx|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|sh|rs|go|sql|css|scss|html|xml|svg|csv|log|lock)\//i.test(file)) return null;
  if (file.startsWith("~")) file = path.join(os.homedir(), file.slice(1));
  let normalized = null;
  if (file.startsWith("/")) normalized = path.normalize(file);
  else if (file.startsWith("./") || file.startsWith("../")) normalized = path.normalize(path.resolve(cwd, file));
  else if (/^[A-Za-z0-9_@.+-][A-Za-z0-9_@.+/\-:]*\.[A-Za-z0-9]+$/.test(file)) {
    normalized = path.normalize(path.resolve(cwd, file));
  } else if (/^(CLAUDE|AGENTS|README|DESIGN|CULTURE|MEMORY)\.md$/.test(file)) {
    normalized = path.normalize(path.resolve(cwd, file));
  }

  if (!normalized) return null;
  try {
    if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) return null;
  } catch {
    // stat 发生竞态时保留候选项，由恢复智能体决定。
  }
  return normalized;
}

function extractPaths(text, cwd) {
  const paths = new Set();
  const s = String(text ?? "");
  const absolute = /(?:^|[\s"'(<\[])(\/(?:Users|private|tmp|var|opt|Volumes)\/[^\s"'()\]<>]+)/g;
  const relative = /(?:^|[\s"'(<\[])((?:\.{1,2}\/)?[A-Za-z0-9_@.+-][A-Za-z0-9_@.+/\-:]*\.(?:md|mdx|txt|json|jsonl|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|sh|rs|go|sql|css|scss|html|xml|svg|csv|log|lock))(?:$|[\s"')>\],.;:])/g;
  const namedMarkdown = /(?:^|[\s"'(<\[])((?:CLAUDE|AGENTS|README|DESIGN|CULTURE|MEMORY)\.md)(?:$|[\s"')>\],.;:])/g;

  for (const regex of [absolute, relative, namedMarkdown]) {
    let match;
    while ((match = regex.exec(s)) !== null) {
      const normalized = normalizeFile(match[1], cwd);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

function createRegistry() {
  const files = new Map();
  let sequence = 0;

  return {
    add(file, kind, source) {
      if (!file) return;
      const existing = files.get(file) ?? {
        path: file,
        kinds: {},
        sources: new Set(),
        firstSeen: sequence,
        lastSeen: sequence,
      };
      existing.kinds[kind] = (existing.kinds[kind] ?? 0) + 1;
      existing.sources.add(source);
      existing.lastSeen = sequence;
      files.set(file, existing);
    },
    tick() {
      sequence += 1;
    },
    values() {
      return [...files.values()].map((entry) => ({
        ...entry,
        sources: [...entry.sources].slice(0, 8),
      }));
    },
  };
}

function toolKind(name, input) {
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "written";
  if (name === "Read") return "read";
  if (["Grep", "Glob", "LS"].includes(name)) return "discovered";
  if (name === "Bash") {
    const command = input?.command ?? "";
    if (/\b(apply_patch|tee|touch|mkdir|mv|cp|rm)\b|(^|[^>])>{1,2}[^>]/.test(command)) return "shell-write";
    return "shell-mentioned";
  }
  return "mentioned";
}

function scoreFile(entry) {
  const ext = path.extname(entry.path).toLowerCase();
  let score = 0;
  if (entry.kinds.written) score += 40;
  if (entry.kinds["shell-write"]) score += 30;
  if (entry.kinds["file-history"]) score += 35;
  if (ext === ".md" || ext === ".mdx") score += 20;
  if (entry.kinds.read) score += 10;
  if (entry.kinds.discovered) score += 4;
  if (/\/docs\/as-built\//.test(entry.path)) score += 25;
  if (/(codemap|architecture|CLAUDE|AGENTS|README|DESIGN|CULTURE|session\.log|queue\.md)/i.test(entry.path)) score += 15;
  score += Math.min(10, Object.values(entry.kinds).reduce((a, b) => a + b, 0));
  return score;
}

function discoverDocs(cwd) {
  const candidates = [
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "docs/as-built",
    "docs",
  ];
  const docs = new Set();

  for (const candidate of candidates) {
    const full = path.resolve(cwd, candidate);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isFile()) docs.add(full);
    if (stat.isDirectory()) {
      const result = spawnSync("find", [full, "-maxdepth", candidate === "docs" ? "2" : "1", "-type", "f", "-name", "*.md"], {
        encoding: "utf8",
      });
      for (const file of result.stdout.split(/\r?\n/).filter(Boolean)) {
        if (/as-built|codemap|architecture|README|overview/i.test(file)) docs.add(path.normalize(file));
      }
    }
  }

  return [...docs].sort();
}

function analyze(jsonlPath, cwd) {
  const records = readJsonLines(jsonlPath);
  const registry = createRegistry();
  const transcript = [];
  const narrative = []; // R4：仅消息轮次（助手/用户文本），不含工具正文。
  const readTargets = new Map(); // R1：Read 调用的 tool_use_id → file_path。
  const cwdCounts = new Map();
  let sessionId = null;

  for (const record of records) {
    registry.tick();
    if (record.sessionId || record.session_id) sessionId = record.sessionId ?? record.session_id;
    if (record.cwd) {
      cwdCounts.set(record.cwd, (cwdCounts.get(record.cwd) ?? 0) + 1);
      cwd = record.cwd;
    }

    if (record.type === "file-history-snapshot") {
      const backups = record.snapshot?.trackedFileBackups ?? {};
      for (const file of Object.keys(backups)) registry.add(path.normalize(file), "file-history", "file-history-snapshot");
    }

    const message = record.message;
    if (!message) continue;
    const role = message.role ?? record.type ?? "unknown";
    const content = message.content;

    if (typeof content === "string") {
      transcript.push(`\n## ${role}\n\n${content}`);
      narrative.push(`\n## ${role}\n\n${content}`);
      for (const file of extractPaths(content, cwd)) registry.add(file, "mentioned", `${role}:text`);
      continue;
    }

    if (!Array.isArray(content)) continue;
    const parts = [];
    const narrativeParts = [];
    for (const block of content) {
      if (block?.type === "text") {
        parts.push(block.text ?? "");
        narrativeParts.push(block.text ?? "");
        for (const file of extractPaths(block.text ?? "", cwd)) registry.add(file, "mentioned", `${role}:text`);
      } else if (block?.type === "tool_use") {
        const name = block.name ?? "unknown";
        const input = block.input ?? {};
        parts.push(`\n[tool_use:${name}]\n${JSON.stringify(input, null, 2)}`);
        if (name === "Read" && block.id && (input.file_path || input.path)) {
          readTargets.set(block.id, input.file_path || input.path);
        }
        const kind = toolKind(name, input);
        if (input.file_path) registry.add(normalizeFile(input.file_path, cwd), kind, `tool:${name}:file_path`);
        if (input.path) registry.add(normalizeFile(input.path, cwd), kind, `tool:${name}:path`);
        if (input.notebook_path) registry.add(normalizeFile(input.notebook_path, cwd), kind, `tool:${name}:notebook_path`);
        for (const text of walkStrings(input)) {
          for (const file of extractPaths(text, cwd)) registry.add(file, kind, `tool:${name}:input`);
        }
      } else if (block?.type === "tool_result") {
        const resultText = stripBinary(stringifyContent(block.content));
        const target = block.tool_use_id && readTargets.get(block.tool_use_id);
        if (target) {
          // R1：Read 结果会复现整个文件，因此输出指针而非正文。实时文件才是当前版本；
          // 转录中的副本只是可能已过期的快照。
          const lineCount = resultText.split("\n").length;
          parts.push(`\n[tool_result：Read ${target}——${lineCount} 行，sha256 ${sha256(resultText)}——请读取实时文件；此快照可能已过期]`);
        } else {
          parts.push(`\n[tool_result]\n${truncate(resultText, TEXT_LIMIT)}`);
        }
        for (const file of extractPaths(resultText, cwd)) registry.add(file, "mentioned", "tool_result");
      }
    }
    if (parts.length) transcript.push(`\n## ${role}\n\n${parts.join("\n")}`);
    if (narrativeParts.some((p) => String(p).trim())) narrative.push(`\n## ${role}\n\n${narrativeParts.join("\n")}`);
  }

  const rankedFiles = registry
    .values()
    .map((entry) => ({ ...entry, score: scoreFile(entry), markdown: [".md", ".mdx"].includes(path.extname(entry.path).toLowerCase()) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const cwdRanked = [...cwdCounts.entries()].sort((a, b) => b[1] - a[1]);
  const effectiveCwd = cwdRanked[0]?.[0] ?? cwd;

  const transcriptText = transcript.join("\n");
  const narrativeText = narrative.join("\n");
  return {
    sessionId,
    jsonlPath,
    cwd: effectiveCwd,
    records: records.length,
    transcript: transcriptText,
    narrative: narrativeText,
    transcriptTokens: Math.round(transcriptText.length / 4),
    narrativeTokens: Math.round(narrativeText.length / 4),
    files: rankedFiles,
    docs: discoverDocs(effectiveCwd),
  };
}

function markdownFileList(files) {
  const lines = [];
  lines.push("# 涉及的文件");
  lines.push("");
  lines.push("文件按恢复相关度排序。应优先完整阅读 Markdown 文件与被写入的文件。");
  lines.push("");

  const sections = [
    ["最高优先级 Markdown/状态文件", (f) => f.markdown && (f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
    ["其他已写入/已跟踪文件", (f) => !f.markdown && (f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
    ["已读取/发现/提及的文件", (f) => !(f.kinds.written || f.kinds["shell-write"] || f.kinds["file-history"])],
  ];

  for (const [title, predicate] of sections) {
    const group = files.filter(predicate);
    if (!group.length) continue;
    lines.push(`## ${title}`);
    lines.push("");
    for (const file of group) {
      const kinds = Object.entries(file.kinds).map(([kind, count]) => `${kind}:${count}`).join(", ");
      lines.push(`- 评分 ${file.score}——\`${file.path}\`——${kinds}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function restoreInstructions(summary, outputPaths) {
  const lines = [];
  lines.push("# Claude 压缩恢复说明");
  lines.push("");
  lines.push("你刚刚经历了压缩，或正在恢复一个已压缩的 Claude Code 席位。你当前的心智模型已被压缩，并不可靠。");
  lines.push("");
  lines.push(`- JSONL 转录：\`${summary.jsonlPath}\``);
  lines.push(`- 重建后的转录：\`${outputPaths.transcript}\`（约 ${summary.transcriptTokens ?? "?"} 个 token——不要从头读到尾）`);
  lines.push(`- 叙事伴随文件（请先阅读）：\`${outputPaths.narrative}\`（约 ${summary.narrativeTokens ?? "?"} 个 token——仅消息轮次，不含工具正文）`);
  lines.push(`- 涉及文件分诊：\`${outputPaths.touchedFiles}\``);
  lines.push(`- 推断出的工作目录：\`${summary.cwd}\``);
  lines.push("");
  lines.push("## 阅读预算（恢复必须为实际工作留出空间）");
  lines.push("");
  lines.push(`- 完整转录约 ${summary.transcriptTokens ?? "?"} 个 token。**从头读到尾可能耗尽恢复本应重建的上下文窗口。**`);
  lines.push(`- 默认顺序：先读**叙事伴随文件**（约 ${summary.narrativeTokens ?? "?"} 个 token，仅消息轮次与决策），从尾部开始，最新优先。`);
  lines.push("- 只有遇到叙事无法回答的具体问题时，才深入完整转录。工具结果中的文件正文现已改为指针——**请读取实时文件，而不是转录快照。**");
  lines.push("- 按预算阅读并设置停止规则；如实报告深度（诚实的部分完成优于虚假完成）。参见技能中的“必需阅读深度审计”。");
  lines.push("");
  lines.push("## 必需步骤");
  lines.push("");
  lines.push("1. 阅读本文件与 `touched-files.md`。");
  lines.push("2. 自问：哪些文件是我记得与工作和项目状态密切相关的？");
  lines.push("3. 在脑中或简短笔记中标记这些文件。");
  lines.push("4. 完整阅读每个重要的 Markdown、状态和规划文件。");
  lines.push("5. 若存在，请完整阅读项目根文档：`CLAUDE.md`、`AGENTS.md`、`README.md`。");
  lines.push("6. 在开展产品工作、代码评审或架构决策前，完整阅读 as-built 文档和 codemap。");
  lines.push("7. 准确声明：`restored from packet at <path>; resumed at step <X>`。");
  lines.push("");
  lines.push("## 文档候选项");
  lines.push("");
  if (summary.docs.length) {
    for (const doc of summary.docs) lines.push(`- \`${doc}\``);
  } else {
    lines.push("- 未自动发现根目录/as-built/codemap 候选项。恢复代码或评审工作前请手动搜索。");
  }
  lines.push("");
  lines.push("## 优先文件候选项");
  lines.push("");
  for (const file of summary.files.slice(0, 30)) {
    lines.push(`- \`${file.path}\`——评分 ${file.score}`);
  }
  lines.push("");
  lines.push("不要只凭模糊记忆继续。");
  return lines.join("\n");
}

// A3-R3 可注入时钟（slice 51-01）：带时间戳的包输出目录路径默认使用真实墙上时钟；
// 设置共享隔离环境变量 OPENRIG_TEST_CLOCK_NOW（ISO 时刻）后改为确定性时间。
// 为空/缺失时使用生产实时。
function nowIso() {
  const injected = process.env.OPENRIG_TEST_CLOCK_NOW;
  return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
}

function writeOutputs(summary, outRoot) {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const base = path.join(outRoot, `${summary.sessionId ?? "unknown-session"}-${stamp}`);
  fs.mkdirSync(base, { recursive: true });

  const outputPaths = {
    dir: base,
    transcript: path.join(base, "transcript.txt"),
    narrative: path.join(base, "transcript-narrative.txt"),
    touchedFiles: path.join(base, "touched-files.md"),
    instructions: path.join(base, "restore-instructions.md"),
    summary: path.join(base, "restore-summary.json"),
  };

  fs.writeFileSync(outputPaths.transcript, summary.transcript || "（未重建出消息转录）\n");
  fs.writeFileSync(outputPaths.narrative, summary.narrative || "（未重建出叙事内容）\n");
  fs.writeFileSync(outputPaths.touchedFiles, markdownFileList(summary.files));
  fs.writeFileSync(outputPaths.instructions, restoreInstructions(summary, outputPaths));
  fs.writeFileSync(outputPaths.summary, JSON.stringify({ ...summary, transcript: undefined, narrative: undefined, outputPaths }, null, 2));

  return outputPaths;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd);
  const jsonlPath = args.jsonl ? path.resolve(args.jsonl) : findLatestJsonl(cwd);
  if (!jsonlPath) throw new Error("找不到 Claude JSONL 转录；请显式传入一个文件");
  if (!fs.existsSync(jsonlPath)) throw new Error(`未找到 JSONL 转录：${jsonlPath}`);

  const summary = analyze(jsonlPath, cwd);
  const outputPaths = writeOutputs(summary, path.resolve(args.out));
  const result = {
    ok: true,
    jsonlPath,
    outputDir: outputPaths.dir,
    transcript: outputPaths.transcript,
    narrative: outputPaths.narrative,
    transcriptTokens: summary.transcriptTokens,
    narrativeTokens: summary.narrativeTokens,
    touchedFiles: outputPaths.touchedFiles,
    instructions: outputPaths.instructions,
    fileCount: summary.files.length,
    topFiles: summary.files.slice(0, 12).map((file) => file.path),
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`恢复包：${result.outputDir}`);
    console.log(`说明：${result.instructions}`);
    console.log(`涉及的文件：${result.touchedFiles}`);
    console.log(`叙事内容（请先阅读）：${result.narrative}（约 ${result.narrativeTokens} 个 token）`);
    console.log(`转录（深入查看）：${result.transcript}（约 ${result.transcriptTokens} 个 token）`);
  }
}

try {
  main();
} catch (error) {
  console.error(`claude-compaction-restore 失败：${error.message}`);
  process.exit(1);
}
