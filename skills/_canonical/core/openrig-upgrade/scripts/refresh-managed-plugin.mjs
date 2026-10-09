#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message, next) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, next }, null, 2)}\n`);
  process.exit(1);
}

function inventory(root) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;

  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.set(relative, {
          kind: "file",
          hash: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
          mode: fs.statSync(absolute).mode & 0o777,
        });
      } else {
        files.set(relative, { kind: "unsupported" });
      }
    }
  }

  walk(root);
  return files;
}

// 相等指完整的清单状态，而不只是字节。mode 与其他本地变更一样：操作员对托管文件执行
// chmod 就已改变它；若只比较 hash，会把该文件误判为可安全刷新，再把它 chmod 回打包模式。
// 清单已经携带 mode；若在此丢弃该维度，就会错误放行写入。
function same(left, right) {
  return left?.kind === "file"
    && right?.kind === "file"
    && left.hash === right.hash
    && left.mode === right.mode;
}

function hasNonDirectoryLiveAncestor(relative, live) {
  const parts = relative.split("/");
  return parts.slice(0, -1).some((_, index) => (
    live.has(parts.slice(0, index + 1).join("/"))
  ));
}

function classify(ancestor, target, live) {
  if ([ancestor, target, live].some((item) => item?.kind === "unsupported")) return "preserve-unsupported-type";
  if (target && live && same(target, live)) return "current";
  if (ancestor && target && live && same(ancestor, live)) return "refresh-safe";
  if (!ancestor && target && !live) return "add-safe";
  if (ancestor && target && live) return "preserve-local-modification";
  if (ancestor && target && !live) return "preserve-local-deletion";
  if (!ancestor && !target && live) return "preserve-live-only";
  if (ancestor && !target && live) return "preserve-target-removal";
  if (!ancestor && target && live) return "preserve-unproven-existing";
  return "preserve-unclassified";
}

function atomicCopy(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.openrig-refresh-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const ancestorArg = argument("--ancestor");
const targetArg = argument("--target");
const liveArg = argument("--live");
const applySafe = process.argv.includes("--apply-safe");
if (!ancestorArg || !targetArg || !liveArg) {
  fail("必须提供 --ancestor、--target 和 --live", "请先确定三个插件根目录，再对任何托管文件分类");
}

const roots = {
  ancestor: path.resolve(ancestorArg),
  target: path.resolve(targetArg),
  live: path.resolve(liveArg),
};
for (const name of ["ancestor", "target"]) {
  if (!fs.existsSync(roots[name]) || !fs.statSync(roots[name]).isDirectory()) {
    fail(`${name} 不是目录：${roots[name]}`, `请先确定 ${name} 打包插件根目录，再重试`);
  }
}
if (fs.existsSync(roots.live) && !fs.statSync(roots.live).isDirectory()) {
  fail(`live 不是目录：${roots.live}`, "不要自动替换非目录的 live 路径");
}

const inventories = {
  ancestor: inventory(roots.ancestor),
  target: inventory(roots.target),
  live: inventory(roots.live),
};
const paths = [...new Set([
  ...inventories.ancestor.keys(),
  ...inventories.target.keys(),
  ...inventories.live.keys(),
])].sort();
const actions = paths.map((relative) => ({
  path: relative,
  decision: hasNonDirectoryLiveAncestor(relative, inventories.live)
    ? "preserve-unsupported-type"
    : classify(
      inventories.ancestor.get(relative),
      inventories.target.get(relative),
      inventories.live.get(relative),
    ),
}));

const written = [];
if (applySafe) {
  for (const action of actions) {
    if (action.decision !== "refresh-safe" && action.decision !== "add-safe") continue;
    const target = inventories.target.get(action.path);
    atomicCopy(path.join(roots.target, action.path), path.join(roots.live, action.path), target.mode);
    written.push(action.path);
  }
}

const preserved = actions.filter((action) => action.decision.startsWith("preserve-"));
process.stdout.write(`${JSON.stringify({
  schema: "openrig-managed-plugin-refresh/v1",
  roots,
  applied: applySafe,
  complete: preserved.length === 0,
  written,
  actions,
  next: preserved.length === 0
    ? "请在外围升级步骤完成后重新运行计划，并验证 live 树"
    : "请逐项处理保留路径；此辅助工具不会删除或覆盖它们",
}, null, 2)}\n`);
