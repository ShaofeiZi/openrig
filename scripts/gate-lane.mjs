#!/usr/bin/env node
// F1 gate-lane runner 入口（arch d6a6c1db，机制 (B) 绑定端口，5 条约束）。把机器级互斥锁
// （gate-lane-lock）+ 诚实间隙各腿 + C2 裁决（gate-lane-run）接成一个闸门：
//   非阻塞获取 lane → 争用时拒绝+说明+非 0 退出（P5）→ 观测外来负载
//   （建议性，记录在案）→ 跑两条腿（typecheck 与 vitest）→
//   写出 C2 裁决（绿要承担它所跑时的负载）→ 释放（进程死亡时内核也会释放端口）。
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, realpathSync, unlinkSync, lstatSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join, dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";
import { renderRefusal, runGate, observeForeignLoad, cleanStaleVendoredBundle } from "./gate-lane-run.mjs";
import { checkDependencyRoot } from "./gate-lane-hermeticity.mjs";

const RUNTIME_DIR = (() => { const d = join(tmpdir(), "openrig-gate"); mkdirSync(d, { recursive: true }); return d; })();
const HOLDER_INFO = join(RUNTIME_DIR, "gate-lane.holder.json");
const VERDICT_PATH = process.env.OPENRIG_GATE_VERDICT ?? join(process.cwd(), "gate-lane-verdict.json");
const SMOKE = process.env.OPENRIG_GATE_LANE_SMOKE === "1"; // 跳过真实各腿（仅冒烟互斥锁/裁决接线）

// F1 排除台账种子（设计上为空）。缺失/损坏 → 当作空台账（严格闸门），绝不静默跳过。
// cutCeiling 来自种子，让“桌面”在一处掌握它。
const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), "gate-lane-exclusions.json");
function loadLedger() {
  try {
    const doc = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return { entries: Array.isArray(doc.entries) ? doc.entries : [], cutCeiling: doc.cutCeiling };
  } catch {
    return { entries: [], cutCeiling: undefined };
  }
}

function snapshotProcesses() {
  try {
    return execSync("ps -eo pid,comm", { encoding: "utf8" }).trim().split("\n").slice(1)
      .map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), command: m[2] } : null; })
      .filter(Boolean);
  } catch { return []; }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result.stdout;
}

function readCandidateSha(repoRoot) {
  const sha = runGit(["rev-parse", "HEAD"], repoRoot).trim();
  if (!sha) throw new Error("候选 HEAD 为空");
  return sha;
}

// 规范化目标路径，使包含性比较在同一口径下进行。这不是对抗性防护：repoRoot 已做 realpath，
// 而在 macOS 上普通 tmpdir 是 `/var/...` 软链到 `/private/var/...`，不规范化的话一个完全合法的
// 路径会被读成“在工作树外”。解析已存在的前缀，再把尚未创建的路径段补回去。
function canonicalizeDestination(destination) {
  let cursor = resolve(destination);
  const missingSegments = [];
  while (true) {
    let exists = true;
    try {
      lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      return resolve(realpathSync(cursor), ...missingSegments);
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`无法解析裁决目标路径：${destination}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

function containedRelativePath(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

// 朴素的包含性检查：把裁决写到工作树外是笔误，这在运行开始改动任何东西之前就抓住它。
// 早先“跟踪路径 / 跟踪软链叶子 / .git 管理项”那几条腿并未实现（创始人裁决，过度工程审查）：
// 它们都需要本信任域内有攻击者，而唯一调用方就是跑自己闸门的“桌面”。
function resolveVerdictDestination(repoRoot) {
  const root = realpathSync(repoRoot);
  const absolutePath = canonicalizeDestination(VERDICT_PATH);
  const relativePath = containedRelativePath(root, absolutePath);
  if (!relativePath) {
    throw new Error(`裁决目标必须位于当前工作树内：${absolutePath}`);
  }
  return { absolutePath, relativePath };
}

function assertCandidateClean(repoRoot, verdictRelativePath) {
  const records = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot)
    .split("\0")
    .filter(Boolean);
  const unexpected = records.filter((record) => {
    if (record.length < 4 || record[2] !== " ") return true;
    return record.slice(3).split(sep).join("/") !== verdictRelativePath;
  });
  if (unexpected.length > 0) {
    throw new Error(`候选工作树不干净：${unexpected.join(" | ")}`);
  }
}

function invalidatePriorVerdict(verdictPath) {
  try {
    unlinkSync(verdictPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const lane = await acquireGateLane({ port: GATE_LANE_PORT, holderInfoPath: HOLDER_INFO });
  if (!lane.ok) {
    console.error(renderRefusal(lane, GATE_LANE_PORT));
    process.exit(2); // 硬拒绝，非阻塞（绝不阻塞等待）
  }
  let exitCode = 3;
  try {
    const repoRoot = process.cwd();
    const verdictDestination = resolveVerdictDestination(repoRoot);
    // 这次获取到的运行取代此前所有收据，包括同一 HEAD 的。
    invalidatePriorVerdict(verdictDestination.absolutePath);
    const foreignLoad = observeForeignLoad({ loadavg: loadavg(), processes: snapshotProcesses() });
    if (foreignLoad.advisory.length) console.warn(`⚠ 建议性告警（退出码不变，已记录在裁决中）：${foreignLoad.advisory.join("; ")}`);
    // 在第一次改动仓库之前，把本次运行钉到一个干净的、工作树内的候选。
    const candidateSha = readCandidateSha(repoRoot);
    assertCandidateClean(repoRoot, verdictDestination.relativePath);
    checkDependencyRoot(repoRoot);
    // 源码真实性：在各腿运行前删掉任何残留的 vendored daemon 包（gitignored 的 build:package 残留），
    // 这样 test:repo 的新鲜度守卫绝不会被桌面残留污染。真实打包时的组装仍受守护；全新检出是 no-op。
    const removedBundle = cleanStaleVendoredBundle(process.cwd());
    console.log(`[gate] 源码真实性：已清理残留的 vendored 包（${removedBundle}）`);
    // 真正的执行器被注入 runGate（跳过分支就在 runGate 内部）。冒烟运行到不了 spawnSync——
    // runGate 在 smoke=true 时选跳过分支。
    const realExec = async (cmd) => { const r = spawnSync(cmd, { shell: true, stdio: "inherit" }); return { ok: r.status === 0, code: r.status }; };
    const { entries: ledger, cutCeiling } = loadLedger();
    // 经由唯一定线点自描述的裁决（gate-lane-run.mjs:runGate）：同一个 SMOKE 既挑执行器又流进裁决，
    // 两者永远不会不一致。闸门自己的阴性对照测试调用的正是同一个 runGate——它守护的是这条发货路径，
    // 而不是一个仿冒品。
    const verdict = await runGate({ smoke: SMOKE, realExec, foreignLoad, startedAt, ledger, cutCeiling });
    const endingSha = readCandidateSha(repoRoot);
    if (endingSha !== candidateSha) {
      throw new Error(`闸门运行期间候选 HEAD 发生变化（开始 ${candidateSha}，结束 ${endingSha}）`);
    }
    assertCandidateClean(repoRoot, verdictDestination.relativePath);
    checkDependencyRoot(repoRoot);
    verdict.candidateSha = candidateSha;
    mkdirSync(dirname(verdictDestination.absolutePath), { recursive: true }); // 确保裁决文件的目录存在
    writeFileSync(verdictDestination.absolutePath, JSON.stringify(verdict, null, 2));
    console.log(verdict.ledgerState); // 带内响亮：逐一列出每个排除项（或“0 exclusions”）
    console.log(`闸门：${verdict.gate.toUpperCase()} — 裁决 → ${verdictDestination.absolutePath}（各腿：${verdict.legs.map((l) => `${l.name}=${l.ok ? "ok" : "FAIL"}`).join(", ")}）`);
    exitCode = verdict.gate === "pass" ? 0 : 1;
  } catch (e) {
    console.error("闸门各腿抛错：", e?.stack ?? e);
    exitCode = 3;
  } finally {
    await lane.release(); // 在退出前释放（进程死亡时内核也会释放端口）
  }
  process.exit(exitCode);
}
main().catch((e) => { console.error("闸门 runner 抛错：", e?.stack ?? e); process.exit(3); });
