#!/usr/bin/env node

// 列出一次变更新增的、与某台机器/网络/账号绑定的值所在行，供作者替换为可移植值或刻意保留。
// 发现结果永远不会让本命令失败：它只是一个疑问，不是裁决。无论有无发现都退出 0；
// 运维类错误（参数错误、git 失败）时退出 2。
//
// 它查找：
//   1. 凭据：密钥、令牌、密码、私钥块。
//   2. home 绝对路径、IP 地址与本地网络主机名。
//   3. 临时与实例专属目录。
//   4. 邮箱地址。
// rig、seat、agent 名属于普通标识符，不报告。
//
// 用法：
//   node scripts/portability-report.mjs                      # origin/main .. HEAD 的 merge-base
//   node scripts/portability-report.mjs --from A --to B      # 一个提交区间
//   node scripts/portability-report.mjs --staged             # 下一次提交已 staged 的内容
//   加 --out report.md 可同时把报告写到文件
//   加 --locations-only 只列文件与行号、不引用匹配文本（用于公开 CI 输出）

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const CHECKS = [
  {
    category: "Credential",
    why: "看起来像凭据；请改为从环境变量或密钥管理服务读取",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|pk_(?:live|test)_[A-Za-z0-9]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b|\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'](?![0-9a-f]{8}-[0-9a-f]{4}-)(?=[^"']*\d)(?=[^"']*[A-Za-z])[^"'\s$<{]{16,}["']/i,
  },
  {
    category: "Home path",
    why: "位于某个人 home 目录下的绝对路径；在其他机器上不存在",
    pattern: /(?:\/Users|\/home)\/(?!(?:example|you|your-?name|username|user|me|someone|name|op|x|test|tester|runner)\/)[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\(?!(?:example|you|user|username)\\)[A-Za-z0-9._-]+\\/,
  },
  {
    category: "Machine path",
    why: "绑定到某台机器的临时或实例专属目录",
    pattern: /\/private\/tmp\/[A-Za-z0-9._-]+|\/var\/folders\/[A-Za-z0-9_]+\/|\/tmp\/claude-\d+|\.openrig-[a-z0-9-]*-[0-9a-f]{6,}/,
  },
  {
    category: "Network address",
    why: "仅在某一网络可解析的 IP 地址或本地网络主机名",
    pattern: /(?<![\w.])(?!127\.|0\.0\.0\.0(?![\w.])|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])|(?<![\w.-])[a-z0-9-]+\.(?:local|lan|internal|ts\.net|home\.arpa)\b(?![.\w-])/i,
  },
  {
    category: "Email address",
    why: "联系方式应放在项目文档中，而不是代码里",
    pattern: /\b(?![A-Za-z0-9._%+-]*noreply)[A-Za-z0-9._%+-]+@(?!(?:example|test|localhost|openrig)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  },
];

// 把 `git diff -U0` 的输出解析成它新增的行，并带上新行号。
export function addedLines(diffText) {
  const lines = [];
  let file = null;
  let lineNumber = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.replace(/^\+\+\+ b\//, "");
    } else if (raw.startsWith("@@")) {
      lineNumber = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (file && raw.startsWith("+")) {
      lines.push({ file, line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    }
  }
  return lines;
}

export function findPortabilityIssues(lines, checks = CHECKS) {
  const findings = [];
  for (const entry of lines) {
    for (const check of checks) {
      const match = check.pattern.exec(entry.text);
      if (match) findings.push({ ...entry, category: check.category, why: check.why, match: match[0] });
    }
  }
  return findings;
}

export function renderReport(findings, label, { locationsOnly = false } = {}) {
  const out = [`# 可移植性报告：${label}`, ""];
  if (findings.length === 0) {
    out.push("未检测到与机器绑定的值。");
    return `${out.join("\n")}\n`;
  }
  out.push(
    `共有 ${findings.length} 处新增行包含可能无法在其他机器上工作的值。对每一处，`,
    "请替换为可移植的值或占位符；若本就是有意保留，则说明理由。",
    "",
  );
  // 报告可能是公开的（CI 摘要），所以疑似凭据绝不重复出现，包括不被另一类别对同一行的摘录带出。
  const secretsByLine = new Map();
  for (const { file, line, match, category } of findings) {
    if (category !== "Credential") continue;
    const key = `${file}:${line}`;
    secretsByLine.set(key, [...(secretsByLine.get(key) ?? []), match]);
  }
  const withhold = (value, key) =>
    (secretsByLine.get(key) ?? []).reduce((text, secret) => text.replaceAll(secret, "[已隐藏]"), value);
  for (const check of CHECKS) {
    const group = findings.filter((finding) => finding.category === check.category);
    if (group.length === 0) continue;
    out.push(`## ${check.category} (${group.length})`, "", `_${check.why}_`, "");
    for (const { file, line, match, text } of group) {
      if (locationsOnly) {
        out.push(`- \`${file}:${line}\``);
        continue;
      }
      if (check.category === "Credential") {
        out.push(`- \`${file}:${line}\` 匹配到 \`${match.slice(0, 6)}…\`（值已隐藏）`);
        continue;
      }
      const key = `${file}:${line}`;
      const safe = withhold(text.trim(), key);
      const excerpt = safe.length > 140 ? `${safe.slice(0, 140)}…` : safe;
      out.push(`- \`${key}\` 匹配到 \`${withhold(match, key)}\`：${excerpt.replaceAll("|", "\\|")}`);
    }
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { staged: false, locationsOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--staged") options.staged = true;
    else if (key === "--locations-only") options.locationsOnly = true;
    else if (["--from", "--to", "--out", "--repo"].includes(key)) options[key.slice(2)] = argv[++index];
    else throw new Error(`未知参数：${key}`);
  }
  return options;
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const repo = resolve(options.repo ?? ".");
  let range;
  let label;
  if (options.staged) {
    range = ["--cached"];
    label = "staged changes";
  } else {
    const to = options.to ?? "HEAD";
    const from = options.from ?? git(repo, ["merge-base", "origin/main", to]).trim();
    range = [`${from}..${to}`];
    label = `${from.slice(0, 8)}..${to.length > 12 ? to.slice(0, 8) : to}`;
  }
  const diff = git(repo, ["diff", "-U0", "--no-color", "--diff-filter=ACMR", ...range]);
  const report = renderReport(findPortabilityIssues(addedLines(diff)), label, {
    locationsOnly: options.locationsOnly,
  });
  process.stdout.write(report);
  if (options.out) writeFileSync(options.out, report);
  return 0;
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
