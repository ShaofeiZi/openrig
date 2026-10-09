#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

const source = argument("--source");
const destination = argument("--destination");
if (!source || !destination) {
  fail("必须提供 --source 和 --destination", "请选择现有 OpenRig SQLite 数据库和新的备份路径");
}

const sourcePath = path.resolve(source);
const destinationPath = path.resolve(destination);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  fail(`源数据库不是普通文件：${sourcePath}`, "请先从后台服务状态确定实时数据库路径，再重试");
}
if (fs.existsSync(destinationPath)) {
  fail(`目标已存在：${destinationPath}`, "请选择新路径；此辅助工具绝不会覆盖备份");
}
if (destinationPath.includes("'") || destinationPath.includes("\n")) {
  fail("目标包含 sqlite3 备份命令不支持的引号或换行符", "请选择简单的文件系统路径");
}

fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
const sqlite = process.env.OPENRIG_SQLITE_BIN || "sqlite3";
const backup = spawnSync(sqlite, [sourcePath, `.backup '${destinationPath}'`], { encoding: "utf8" });
if (backup.status !== 0) {
  fs.rmSync(destinationPath, { force: true });
  fail(
    backup.stderr?.trim() || backup.stdout?.trim() || backup.error?.message || "sqlite3 备份失败",
    `请对源文件直接运行 ${sqlite}，解决锁定、路径或工具错误，再选择新的目标路径`,
  );
}

const check = spawnSync(sqlite, [destinationPath, "PRAGMA integrity_check;"], { encoding: "utf8" });
const integrity = check.stdout?.trim();
if (check.status !== 0 || integrity !== "ok") {
  fail(
    check.stderr?.trim() || `备份完整性结果为 ${JSON.stringify(integrity)}`,
    "仅保留失败备份用于诊断；不要用它回滚",
  );
}

process.stdout.write(`${JSON.stringify({
  schema: "openrig-sqlite-backup/v1",
  ok: true,
  source: sourcePath,
  destination: destinationPath,
  bytes: fs.statSync(destinationPath).size,
  integrity,
}, null, 2)}\n`);
