// OPR.0.3.4.8——POST /api/rigs/:rigId/cmux/launch。
// 用 tmuxAdapter.hasSession 检测的真实 tmux 存活替换 sessionStatus=running
// 标签过滤。为仍在 boot 的席位增加有界就绪等待，并返回诚实的部分响应
// （已打开 vs 缺失，带每席位原因）。

import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { CmuxLayoutService } from "../domain/cmux-layout-service.js";

export const rigCmuxRoutes = new Hono();

interface NodeInventoryStubEntry {
  logicalId: string;
  canonicalSessionName: string | null;
  sessionStatus: string | null;
  attachmentType: string | null;
}

type NodeInventoryFn = (rigId: string) => NodeInventoryStubEntry[];

interface RigCmuxDeps {
  rigRepo: RigRepository;
  cmuxAdapter: CmuxAdapter;
  cmuxLayoutService: CmuxLayoutService;
  nodeInventoryFn: NodeInventoryFn;
  tmuxAdapter: TmuxAdapter;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
}

function getDeps(c: { get: (key: string) => unknown }): RigCmuxDeps {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    cmuxLayoutService: c.get("cmuxLayoutService" as never) as CmuxLayoutService,
    nodeInventoryFn: c.get("nodeInventoryFn" as never) as NodeInventoryFn,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    readinessTimeoutMs: c.get("readinessTimeoutMs" as never) as number | undefined,
    readinessPollMs: c.get("readinessPollMs" as never) as number | undefined,
  };
}

function pickNonCollidingName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) return baseName;
  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

const READINESS_POLL_MS = 500;
const READINESS_TIMEOUT_MS = 5_000;

interface MissingSeat {
  logicalId: string;
  reason: string;
}

rigCmuxRoutes.post("/launch", async (c) => {
  const rigId = c.req.param("rigId")!;
  const deps = getDeps(c);
  const { rigRepo, cmuxAdapter, cmuxLayoutService, nodeInventoryFn, tmuxAdapter } = deps;
  const effectiveTimeoutMs = deps.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
  const effectivePollMs = deps.readinessPollMs ?? READINESS_POLL_MS;

  const rigWithRelations = rigRepo.getRig(rigId);
  if (!rigWithRelations) {
    return c.json(
      {
        ok: false,
        error: "rig_not_found",
        message: `未找到工作组 "${rigId}"——无法 launch cmux workspace——请尝试：zrig ps`,
      },
      404,
    );
  }

  if (!cmuxAdapter.isAvailable()) {
    return c.json(
      {
        ok: false,
        error: "cmux_unavailable",
        message:
          "本主机上 cmux 不可用——无法 launch workspace——请从 https://cmux.io 安装 cmux 并运行：cmux ping",
      },
      503,
    );
  }

  const inventory = nodeInventoryFn(rigId);

  // OPR.0.3.4.8：按真实 tmux 存活判别，而非 status 标签。
  // 席位可 attach 当且仅当它有 canonicalSessionName、tmux 兼容、
  // 且 tmuxAdapter.hasSession(name) 为 true（session 真实存活）。
  // 死/陈旧名字（hasSession false）绝不 attach——保留原 running-only 过滤器的安全不变量。
  const launchableByLogical = new Map<string, string>();
  const missing: MissingSeat[] = [];
  const nonTmuxIds = new Set<string>();
  const STALE_STATUSES = new Set(["exited", "detached"]);

  // 收集候选：有 tmux 兼容 canonical 名字的席位。
  // 跟踪原始 sessionStatus 用于原因分类。
  interface Candidate { logicalId: string; sessionName: string; sessionStatus: string | null }
  const candidates: Candidate[] = [];
  const noSessionIds = new Set<string>();

  for (const entry of inventory) {
    if (!entry.canonicalSessionName) {
      noSessionIds.add(entry.logicalId);
      continue;
    }
    if (entry.attachmentType != null && entry.attachmentType !== "tmux") {
      nonTmuxIds.add(entry.logicalId);
      missing.push({ logicalId: entry.logicalId, reason: "non-tmux" });
      continue;
    }
    candidates.push({ logicalId: entry.logicalId, sessionName: entry.canonicalSessionName, sessionStatus: entry.sessionStatus });
  }

  // 有界就绪等待，并对无 session 席位重新读取。
  // 轮询候选的 tmux 存活，并重新读 inventory 以发现无 session 席位新出现的 session。
  const deadline = Date.now() + effectiveTimeoutMs;
  const pending = new Map(candidates.map((c) => [c.logicalId, c]));
  let firstPass = true;

  while ((pending.size > 0 || noSessionIds.size > 0) && Date.now() < deadline) {
    let foundThisCycle = 0;
    let noSessionDiscovered = 0;

    // 对无 session 席位重新读 inventory，以发现新出现的 session。
    if (noSessionIds.size > 0) {
      const freshInventory = nodeInventoryFn(rigId);
      for (const entry of freshInventory) {
        if (!noSessionIds.has(entry.logicalId)) continue;
        if (entry.canonicalSessionName && (entry.attachmentType == null || entry.attachmentType === "tmux")) {
          noSessionIds.delete(entry.logicalId);
          pending.set(entry.logicalId, { logicalId: entry.logicalId, sessionName: entry.canonicalSessionName, sessionStatus: entry.sessionStatus });
          noSessionDiscovered++;
        }
      }
    }

    // 检查所有 pending 候选的 tmux 存活。
    for (const [logicalId, candidate] of [...pending]) {
      try {
        const alive = await tmuxAdapter.hasSession(candidate.sessionName);
        if (alive) {
          launchableByLogical.set(logicalId, candidate.sessionName);
          pending.delete(logicalId);
          foundThisCycle++;
        }
      } catch {
        // probe 失败——本周期视为尚未存活。
      }
    }
    if (pending.size === 0 && noSessionIds.size === 0) break;
    // 当本周期无进展（无新存活 session 且无新发现的无 session 席位）
    // 且所有剩余 pending 均为已知陈旧时提前退出。
    if (!firstPass && foundThisCycle === 0 && noSessionDiscovered === 0 && noSessionIds.size === 0) {
      const allPendingStale = pending.size === 0 || [...pending.values()].every((c) => STALE_STATUSES.has(c.sessionStatus ?? ""));
      if (allPendingStale) break;
    }
    firstPass = false;
    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, effectivePollMs));
    }
  }

  // 以原因保真度分类剩余 pending/无 session。
  for (const [logicalId, candidate] of pending) {
    const isStale = STALE_STATUSES.has(candidate.sessionStatus ?? "");
    missing.push({ logicalId, reason: isStale ? "session-missing" : "still-booting" });
  }
  for (const logicalId of noSessionIds) {
    missing.push({ logicalId, reason: "no-session" });
  }

  // rig.nodes 按 DB ORDER BY created_at——确定性的智能体排序。
  const orderedSessions: string[] = [];
  for (const node of rigWithRelations.nodes) {
    const session = launchableByLogical.get(node.logicalId);
    if (session) orderedSessions.push(session);
  }

  if (orderedSessions.length === 0) {
    const rigName = (rigWithRelations.rig as unknown as { name: string }).name;
    return c.json(
      {
        ok: false,
        error: "rig_not_running",
        message: `工作组 "${rigName}" 没有存活的 tmux session——无法 attach 到任何东西——请运行：zrig up ${rigName}`,
        missing,
      },
      412,
    );
  }

  const listResult = await cmuxAdapter.listWorkspaces();
  const existingNames = new Set<string>(
    listResult.ok ? listResult.data.map((w) => w.name) : [],
  );

  const chunks = CmuxLayoutService.chunkAgents(orderedSessions);
  const baseName = (rigWithRelations.rig as unknown as { name: string }).name;
  const workspaces: Array<{ name: string; agents: string[]; blanks: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const desired = i === 0 ? baseName : `${baseName}-${i + 1}`;
    const name = pickNonCollidingName(desired, existingNames);
    existingNames.add(name);

    const build = await cmuxLayoutService.buildWorkspace(name, undefined, chunks[i]!);
    if (!build.ok) {
      return c.json(
        {
          ok: false,
          error: "build_workspace_failed",
          message: build.message,
          partial: workspaces,
        },
        500,
      );
    }
    workspaces.push({
      name: build.data.workspaceName,
      agents: build.data.agents,
      blanks: build.data.blanks,
    });
  }

  return c.json({
    ok: true,
    workspaces,
    ...(missing.length > 0 ? { missing } : {}),
  });
});
