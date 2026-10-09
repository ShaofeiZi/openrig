#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const rig = process.env.OPENRIG_RIG_BIN || "rig";

function probe(name, args, next) {
  const result = spawnSync(rig, args, { encoding: "utf8" });
  const stdout = result.stdout?.trim() || "";
  const stderr = result.stderr?.trim() || "";
  if (result.status === 0) {
    let value = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // 版本命令与旧版表面可能有意返回纯文本。
    }
    return { name, ok: true, command: [rig, ...args], value };
  }
  return {
    name,
    ok: false,
    command: [rig, ...args],
    exitCode: result.status,
    error: stderr || stdout || result.error?.message || "命令未产生诊断信息",
    next,
  };
}

const report = {
  schema: "openrig-upgrade-inspection/v1",
  generatedAt: new Date().toISOString(),
  rigVersion: probe("rigVersion", ["--version"], `请直接运行 ${rig} --version 并验证已安装包装器`),
  daemonStatus: probe("daemonStatus", ["daemon", "status"], `请运行 ${rig} daemon status 并检查后台服务状态和日志`),
  nodes: probe("nodes", ["ps", "--nodes", "-A", "--json"], `请运行 ${rig} ps --nodes -A --json，并在变更前解决控制面可达性问题`),
  plugins: probe("plugins", ["plugin", "list", "--json"], `请运行 ${rig} plugin list --json，并在刷新前确定已安装插件根目录`),
};

report.ready = [report.rigVersion, report.daemonStatus, report.nodes, report.plugins].every((item) => item.ok);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
