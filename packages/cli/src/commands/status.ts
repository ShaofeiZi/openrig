import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  type LifecycleDeps,
  statusGuardMessage,
} from "../daemon-lifecycle.js";
import { readLifecycleDescription } from "../daemon-lifecycle-status.js";
import { realDeps } from "./daemon.js";
import { ConfigStore } from "../config-store.js";

export interface StatusDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (baseUrl: string) => DaemonClient;
}

function formatSnapshotAge(snapshotAt: string | null): string {
  if (!snapshotAt) return "无";
  const now = Date.now();
  const then = new Date(snapshotAt).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} 天前`;
}

export function statusCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("status").description("显示工作组状态");

  cmd.action(async () => {
    const deps = depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
    };

    const status = await getDaemonStatus(deps.lifecycleDeps);

    if (status.state === "stopped" || status.state === "stale") {
      console.log(statusGuardMessage(status).fact); // B8-1b：单一语言来源
      // P7 — 崩溃后仍可读取的生命周期信息：正常停止会记录 stopped_at；
      // 若没有该记录但存在启动记录，则说明是崩溃/kill-9/断电。SQLite 在 pid
      // 失效后仍可读取，daemon.json 不行——因此这里只读 db，绝不读 daemon.json。
      const life = readLifecycleDescription();
      if (life.kind === "clean-shutdown") {
        console.log(`  已于 ${life.stoppedAt} 正常关闭`);
      } else if (life.kind === "no-clean-shutdown") {
        console.log(`  ⚠ 未记录正常关闭——最后活动时间 ${life.lastSeen}`);
      }
      return;
    }

    // state === "running"
    if (status.healthy === false) {
      console.log(`后台服务正在运行（pid ${status.pid}）但健康状态异常——healthz 检查失败`);
      return;
    }

    const client = deps.clientFactory(getDaemonUrl(status));

    // 拉取摘要 + cmux + 内核就绪状态
    const [summaryRes, cmuxRes, kernelRes] = await Promise.all([
      client.get<Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null }>>("/api/rigs/summary"),
      client.get<{ available: boolean }>("/api/adapters/cmux/status").catch(() => null),
      client.get<{ kernel_state?: string; error?: string }>("/api/kernel/status").catch(() => null),
    ]);

    console.log(`后台服务运行于端口 ${status.port}`);

    // OPR.0.3.3.04.2 (AC-2)：内核就绪状态是与后台服务健康状态不同的信号——
    // 内核工作组在后台服务启动时自动引导，后台服务已起来时内核可能尚未就绪
    // （或内核内的智能体不健康）。这里只展示"当前真实状态"，绝不保证下游
    // 智能体一定健康。
    if (kernelRes && kernelRes.status === 200 && kernelRes.data?.kernel_state) {
      console.log(`内核：${kernelRes.data.kernel_state}（随后台服务启动自动引导；与后台服务健康状态是两个信号）`);
    } else if (kernelRes && kernelRes.status === 503) {
      console.log("内核：未跟踪（未接入内核引导跟踪器）");
    } else {
      console.log("内核：未知（状态不可用）");
    }

    // OPR.0.3.3.04.2 (AC-2 / gap #7)：展示当前生效的工作区根目录，以及它
    // 是默认值还是被覆盖——操作人员无需猜测。这里只报告当前生效的值，
    // 不代表某个根目录就是"正确"的。
    try {
      const resolved = new ConfigStore().resolveWithSource("workspace.root");
      const origin = resolved.source === "default" ? "默认值" : `来自 ${resolved.source} 的覆盖`;
      console.log(`工作区根目录：${resolved.value}（${origin}）`);
    } catch {
      // 配置解析不可用——宁可省略也不猜测。
    }

    if (summaryRes.status !== 200) {
      console.error(`工作组摘要获取失败（HTTP ${summaryRes.status}）`);
      process.exitCode = 1;
      return;
    }

    const rigs = summaryRes.data;
    if (rigs.length === 0) {
      console.log("暂无工作组");
    } else {
      console.log(`${rigs.length} 个工作组：`);
      for (const rig of rigs) {
        const snap = formatSnapshotAge(rig.latestSnapshotAt);
        console.log(`  ${rig.name}  ${rig.nodeCount} 个节点  快照：${snap}`);
      }
    }

    // cmux 状态
    const cmuxAvailable = cmuxRes?.data?.available ?? false;
    console.log(`cmux：${cmuxAvailable ? "可用" : "不可用"}`);

    // OPR.0.3.3.04.2 (AC-1)：提示回到唯一的标准有序路径——status 不重新编排
    // 流程顺序（顺序见 `zrig setup` 的后续步骤与 docs/reference/getting-started.md）。
    if (rigs.length === 0) {
      console.log(`\n下一步：用 \`zrig up <rig-spec>\` 启动工作组。引导路径：\`zrig setup\` 输出或 docs/reference/getting-started.md`);
    }
  });

  return cmd;
}
