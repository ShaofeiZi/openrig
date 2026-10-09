import { Command } from "commander";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type LaunchResponse = {
  ok: boolean;
  rigId?: string;
  nodeId?: string;
  logicalId?: string;
  sessionName?: string;
  error?: string;
  message?: string;
  code?: string;
  launched?: Array<{ nodeId: string; logicalId: string; status: string; error?: string }>;
  held?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  failedTargets?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  targetNodes?: Array<{ nodeId: string; logicalId: string }>;
  snapshotSelection?: { snapshotId: string; kind: string; createdAt: string; ageMs: number; mode: "explicit" | "automatic"; rationale: string; newerUsableAlternative: unknown };
  nonTargetEffects?: { mode: "unchanged" | "detach_and_hold"; reason: string | null; affected: unknown[] };
  planOnly?: boolean;
  // OPR.0.4.3.28 修正——非阻塞的启动警告（例如 liveness_probe_unknown：tmux
  // 存活探测失败但仍已启动）。作为人类输出呈现，但不设置非零退出码。
  warnings?: string[];
};

// OPR.0.4.3.20 FR-7——表示没有任何会话在跑的启动条目状态（操作人员必须处置）。
// 这些不是成功启动——绝不要为它们打印"已启动"；以非零退出码退出。
// 与后台服务的 NON_RUNNING_LAUNCH_STATUSES 对齐。
const NON_RUNNING_LAUNCH_STATUSES = new Set(["awaiting-decision", "attention_required", "failed"]);
function launchStatusRunning(status: string): boolean {
  return !NON_RUNNING_LAUNCH_STATUSES.has(status);
}

function printSnapshotSelection(selection: LaunchResponse["snapshotSelection"]): void {
  if (!selection) return;
  console.log(`快照：${selection.snapshotId}（${selection.kind}，${selection.mode}，年龄 ${Math.round(selection.ageMs / 1000)}s）`);
  console.log(`选择依据：${selection.rationale}`);
  const newer = selection.newerUsableAlternative as { snapshotId?: string; kind?: string } | null;
  if (newer?.snapshotId) console.log(`更新的可用替代：${newer.snapshotId}${newer.kind ? `（${newer.kind}）` : ""}`);
}

export function launchCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("launch").description("在运行中的工作组里启动或重新启动一个节点");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "目标工作组 ID")
    .argument("[nodeRef]", "节点逻辑 ID 或节点 ID（单目标）")
    .option("--seats <ids>", "用于子集启动的逗号分隔逻辑 ID")
    .option("--hold-reason <reason>", "保持非目标席位的原因")
    .option("--snapshot-id <id>", "使用这个确切的可恢复快照")
    .option("--retry-startup-from <member-file>", "用原始 member fragment 重试在投影阶段失败的已停止首次启动")
    .option("--rig-root <path>", "--retry-startup-from 对应的原始绝对源码根目录")
    .option("--plan", "只展示子集选择与非目标影响，不修改")
    .option("--json", "以 JSON 输出")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上运行")
    .action(async (rigId: string, nodeRef: string | undefined, opts: { json?: boolean; holdReason?: string; seats?: string; host?: string; snapshotId?: string; plan?: boolean; retryStartupFrom?: string; rigRoot?: string }) => {
      // OPR.0.4.6.MH1 FR-2：选定主机路由——显式 --host 优先；
      // 否则把已保存的选择喂给已交付的 --host 路径；没有选择则与今日行为完全一致。
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();
      let retryBody: { retryStartupFrom: { member: Record<string, unknown>; rigRoot: string } } | undefined;
      if (opts.retryStartupFrom || opts.rigRoot) {
        if (!nodeRef || !opts.retryStartupFrom || !opts.rigRoot || !isAbsolute(opts.rigRoot) || opts.seats || opts.snapshotId || opts.plan || opts.holdReason) {
          console.error("首次启动重试需要一个节点、--retry-startup-from 和绝对路径的 --rig-root；不能与 snapshot/子集/plan 选项组合。");
          process.exitCode = 1;
          return;
        }
        try {
          const { parse } = await import("yaml");
          const parsed = parse(readFileSync(opts.retryStartupFrom, "utf8"));
          const member = parsed?.member ?? parsed;
          if (!member || typeof member !== "object" || Array.isArray(member) || parsed.edges || member.edges) throw new Error("请提供一个不带 edges 的单一 member fragment；重试会保留现有拓扑。");
          retryBody = { retryStartupFrom: { member, rigRoot: opts.rigRoot } };
        } catch (error) {
          console.error(`无法读取重试 member：${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }

      if (opts.host) {
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const seatList = opts.seats ? opts.seats.split(",").map((s) => s.trim()).filter(Boolean) : [];
        let apiPath: string;
        let body: unknown;
        if (seatList.length > 0) {
          apiPath = `/api/rigs/${encodeURIComponent(rigId)}/nodes/launch-subset`;
          body = { seats: seatList, ...(opts.holdReason ? { holdReason: opts.holdReason } : {}), ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}), ...(opts.plan ? { plan: true } : {}) };
        } else if (nodeRef) {
          if (opts.holdReason) {
            console.error("--hold-reason 仅适用于多席位 --seats 启动；单席位启动不会改变非目标");
            process.exitCode = 1;
            return;
          }
          if (opts.plan) {
            console.error("--plan 目前仅适用于多席位 --seats 启动");
            process.exitCode = 1;
            return;
          }
          apiPath = `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}/launch`;
          body = retryBody ?? (opts.snapshotId ? { snapshotId: opts.snapshotId } : {});
        } else {
          console.error("launch --host 需要节点引用或 --seats");
          process.exitCode = 1;
          return;
        }
        const result = await runRemoteHttpOp(opts.host, "POST", apiPath, body, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`主机 ${opts.host} 上出错：${result.error}`);
          process.exitCode = 1;
        }
        return;
      }

      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const seatList = opts.seats ? opts.seats.split(",").map((s) => s.trim()).filter(Boolean) : [];

      if (seatList.length > 0) {
        const body: { seats: string[]; holdReason?: string; snapshotId?: string; plan?: boolean } = { seats: seatList };
        if (opts.holdReason) body.holdReason = opts.holdReason;
        if (opts.snapshotId) body.snapshotId = opts.snapshotId;
        if (opts.plan) body.plan = true;
        const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/launch-subset`, body);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }
        if (opts.plan && res.data.planOnly) {
          console.log("仅计划；未做任何修改。");
          printSnapshotSelection(res.data.snapshotSelection);
          console.log(`非目标影响：${res.data.nonTargetEffects?.mode ?? "不可用"}`);
          for (const node of res.data.nonTargetEffects?.affected ?? []) {
            const affected = node as { logicalId?: string; reason?: string };
            console.log(`  ${affected.logicalId ?? "未知"}：${affected.reason ?? "未说明"}`);
          }
          return;
        }
        // 硬失败（没有逐席位结果可渲染——例如 rig_not_found）：报错并退出。
        if (!res.data.launched && !res.data.held && !res.data.alreadyRunning) {
          console.error(res.data.error ?? res.data.message ?? `启动失败（HTTP ${res.status}）`);
          process.exitCode = 1;
          return;
        }
        // OPR.0.4.3.20 FR-7——只有真正在运行的恢复结果才算"已启动"。
        // 落到 awaiting-decision / attention_required / failed 的席位没有
        // 启动（没有会话在跑）——如实打印并以非零退出码退出。
        const launchedAll = res.data.launched ?? [];
        printSnapshotSelection(res.data.snapshotSelection);
        const running = launchedAll.filter((n) => launchStatusRunning(n.status));
        const needsDecision = launchedAll.filter((n) => !launchStatusRunning(n.status));
        const heldIds = (res.data.held ?? []).map((n) => `${n.logicalId} (${n.reason})`).join(", ");
        if (running.length) console.log(`已启动：${running.map((n) => n.logicalId).join(", ")}`);
        if (heldIds) console.log(`保持：${heldIds}`);
        if (res.data.alreadyRunning?.length) console.log(`已在运行：${res.data.alreadyRunning.map((n) => n.logicalId).join(", ")}`);
        // OPR.0.4.3.28 修正——带警告继续：打印非阻塞启动警告（例如
        // liveness_probe_unknown），不设置非零退出码。
        for (const w of res.data.warnings ?? []) console.warn(`警告：${w}`);
        for (const n of needsDecision) {
          console.error(`  ${n.logicalId}: ${n.status}${n.error ? ` — ${n.error}` : ""}`);
        }
        if (needsDecision.length > 0) process.exitCode = 1;
        if (res.data.failedTargets?.length) {
          console.error(`失败（存活状态未知）：${res.data.failedTargets.map((n) => n.logicalId).join(", ")}`);
          process.exitCode = 1;
        }
        if ((res.data as Record<string, unknown>).unmatchedIds && ((res.data as Record<string, unknown>).unmatchedIds as string[]).length > 0) {
          console.error(`未匹配的席位（未找到）：${((res.data as Record<string, unknown>).unmatchedIds as string[]).join(", ")}`);
          process.exitCode = 1;
        }
        return;
      }

      if (!nodeRef) {
        console.error("请提供节点逻辑 ID，或用 --seats <a,b> 做子集启动");
        process.exitCode = 1;
        return;
      }
      if (opts.plan) {
        console.error("--plan 目前仅适用于多席位 --seats 启动");
        process.exitCode = 1;
        return;
      }
      if (opts.holdReason) {
        console.error("--hold-reason 仅适用于多席位 --seats 启动；单席位启动不会改变非目标");
        process.exitCode = 1;
        return;
      }

      const body: Record<string, unknown> = retryBody ?? {};
      if (opts.snapshotId) body.snapshotId = opts.snapshotId;

      const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}/launch`, body);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? res.data.message ?? `启动失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      const logicalId = res.data.logicalId ?? nodeRef;
      printSnapshotSelection(res.data.snapshotSelection);
      // OPR.0.4.3.28 修正——带警告继续：打印非阻塞启动警告（例如
      // liveness_probe_unknown），不设置非零退出码。
      const printLaunchWarnings = () => {
        for (const w of res.data.warnings ?? []) console.warn(`警告：${w}`);
      };
      if (res.data.code === "already_running" || (res.data.alreadyRunning && res.data.alreadyRunning.length > 0)) {
        console.log(`节点 ${logicalId} 已在工作组 ${rigId} 中运行（未重新启动）`);
        printLaunchWarnings();
        return;
      }
      const sessionSuffix = res.data.sessionName ? `（${res.data.sessionName}）` : "";
      console.log(`已在工作组 ${rigId} 中启动节点 ${logicalId}${sessionSuffix}`);
      printLaunchWarnings();
    });

  return cmd;
}
