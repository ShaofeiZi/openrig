import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry, type StartupContextProbeResult } from "../domain/restore-check-service.js";
import { getNodeInventory } from "../domain/node-inventory.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";

function getDeps(c: { get(key: never): unknown }): {
  rigRepo: RigRepository;
  snapshotRepo: SnapshotRepository;
} {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
  };
}

export const restoreCheckRoutes = new Hono();

function getNodeIdMap(db: Database.Database, rigId: string): Map<string, string> {
  const rows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  return new Map(rows.map((row) => [row.logical_id, row.id]));
}

function parseStartupContextJsonField<T>(
  raw: string,
  fieldName: string,
  nodeId: string,
): { ok: true; value: T } | { ok: false; evidence: string } {
  try {
    const parsed = JSON.parse(raw) as T;
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      evidence: `节点 ${nodeId} 字段 ${fieldName} 的持久化启动上下文 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getStartupContext(db: Database.Database, nodeId: string): StartupContextProbeResult {
  try {
    const row = db.prepare(
      "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?"
    ).get(nodeId) as
      | {
          projection_entries_json: string;
          resolved_files_json: string;
          startup_actions_json: string;
          runtime: string | null;
        }
      | undefined;

    if (!row) {
      return {
        status: "missing",
        evidence: `节点 ${nodeId} 缺少持久化启动上下文`,
      };
    }

    const resolvedFiles = parseStartupContextJsonField<unknown[]>(row.resolved_files_json, "resolved_files_json", nodeId);
    if (!resolvedFiles.ok) {
      return { status: "malformed", evidence: resolvedFiles.evidence };
    }
    if (!Array.isArray(resolvedFiles.value)) {
      return {
        status: "malformed",
        evidence: `节点 ${nodeId} 的持久化启动上下文字段 resolved_files_json 不是数组`,
      };
    }

    const projectionEntries = parseStartupContextJsonField<unknown[]>(row.projection_entries_json, "projection_entries_json", nodeId);
    if (!projectionEntries.ok) {
      return { status: "malformed", evidence: projectionEntries.evidence };
    }
    if (!Array.isArray(projectionEntries.value)) {
      return {
        status: "malformed",
        evidence: `节点 ${nodeId} 的持久化启动上下文字段 projection_entries_json 不是数组`,
      };
    }

    const startupActions = parseStartupContextJsonField<unknown[]>(row.startup_actions_json, "startup_actions_json", nodeId);
    if (!startupActions.ok) {
      return { status: "malformed", evidence: startupActions.evidence };
    }
    if (!Array.isArray(startupActions.value)) {
      return {
        status: "malformed",
        evidence: `节点 ${nodeId} 的持久化启动上下文字段 startup_actions_json 不是数组`,
      };
    }

    return {
      status: "ok",
      runtime: row.runtime,
      resolvedStartupFiles: resolvedFiles.value.flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const candidate = file as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          required: candidate["required"] !== false,
          path: typeof candidate["path"] === "string" ? candidate["path"] : null,
          deliveryHint: typeof candidate["deliveryHint"] === "string" ? candidate["deliveryHint"] : null,
        }];
      }),
      projectionEntries: projectionEntries.value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          effectiveId: typeof candidate["effectiveId"] === "string" ? candidate["effectiveId"] : null,
          category: typeof candidate["category"] === "string" ? candidate["category"] : null,
        }];
      }),
    };
  } catch (err) {
    return {
      status: "probe_error",
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * OPR.0.4.3.22——构建一个接到线上后台服务仓库的 RestoreCheckService。
 * 抽出来是为了让 rig-status compose 路由能消费与 `/api/restore-check` 路由
 * 发出的同一个 restore-check 就绪信号（RecoveryPlan），而不是重新实现一遍
 * （ponytail：一份 restore-check，组合复用）。
 */
export function createRestoreCheckService(
  rigRepo: RigRepository,
  snapshotRepo: SnapshotRepository,
): RestoreCheckService {
  const serviceDeps: RestoreCheckDeps = {
    listRigs: () => {
      const rigs = rigRepo.listRigs();
      return rigs.map((r) => ({ rigId: r.id, name: r.name }));
    },
    getNodeInventory: (rigId: string) => {
      const nodeIdByLogicalId = getNodeIdMap(rigRepo.db, rigId);
      return getNodeInventory(rigRepo.db, rigId).map((entry) => ({
        ...entry,
        nodeId: nodeIdByLogicalId.get(entry.logicalId) ?? null,
      })) as NodeInventoryEntry[];
    },
    getStartupContext: (nodeId: string) => {
      return getStartupContext(rigRepo.db, nodeId);
    },
    hasSnapshot: (rigId: string) => {
      return snapshotRepo.listSnapshots(rigId).length > 0;
    },
    getLatestSnapshot: (rigId: string) => {
      const snapshot = snapshotRepo.getLatestSnapshot(rigId);
      return snapshot ? { id: snapshot.id, kind: snapshot.kind } : null;
    },
    probeDaemonHealth: () => {
      // 我们就在后台服务里——如果本路由能响应，说明后台服务健康
      return { healthy: true, evidence: "后台服务运行中（正在响应 API 请求）" };
    },
    exists: (path: string) => {
      try { return existsSync(path); } catch { return false; }
    },
    readFile: (path: string) => readFileSync(path, "utf-8"),
  };
  return new RestoreCheckService(serviceDeps);
}

// GET /api/restore-check?rig=<name>&noQueue=true&noHooks=true&compact=1
restoreCheckRoutes.get("/", (c) => {
  const deps = getDeps(c);
  const rigFilter = c.req.query("rig") ?? undefined;
  const noQueue = c.req.query("noQueue") === "true";
  const noHooks = c.req.query("noHooks") === "true";
  const compact = c.req.query("compact") === "1";
  // OPR.0.4.0.29 FR-2：--ready 保持紧凑，但包含 ready 席位细节。
  const includeReady = c.req.query("ready") === "1";

  try {
    const service = createRestoreCheckService(deps.rigRepo, deps.snapshotRepo);
    const result = service.check({ rig: rigFilter, noQueue, noHooks, compact, includeReady });

    if (compact) {
      const compactResult = {
        verdict: result.verdict,
        readiness: result.readiness,
        counts: result.counts,
        classCounts: result.classCounts,
        rigs: result.rigs.map((r) => ({
          rigId: r.rigId,
          rigName: r.rigName,
          status: r.status,
          verdict: r.verdict,
          expectedNodes: r.expectedNodes,
          runningReadyNodes: r.runningReadyNodes,
          blockedNodes: r.blockedNodes,
          caveatNodes: r.caveatNodes,
        })),
        // --ready (ready=1) 在紧凑模式下保留 ready 席位检查；
        // 默认紧凑为节省 token 丢弃 green（ready）检查。
        checks: includeReady ? result.checks : result.checks.filter((ch) => ch.status !== "green"),
        recovery: {
          status: result.recovery.status,
          summary: result.recovery.summary,
          actions: result.recovery.actions,
          blocked: result.recovery.blocked,
        },
      };
      return c.json(compactResult);
    }

    return c.json(result);
  } catch (err) {
    const evidence = `服务错误：${err instanceof Error ? err.message : String(err)}`;

    return c.json({
      verdict: "unknown",
      readiness: {
        status: "unknown",
        reason: "unknown_probe_state",
        blockingRigCount: 0,
        caveatRigCount: 0,
        unknownRigCount: 0,
      },
      continuity: {
        status: "not_proven",
        evidence: "严格的同会话/provider 上下文恢复未经 restore-check v1 验证。",
        provenCapabilities: [],
        unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
      },
      rigs: [],
      hostInfra: {
        status: "unknown",
        evidence: "restore-check 路由失败，无法检视 host bootstrap/autostart 来源",
      },
      recovery: {
        status: "unknown",
        summary: "restore-check 路由失败，无法检视恢复状态。",
        actions: [],
        blocked: [],
        unknown: [{
          scope: "host",
          reason: evidence,
        }],
      },
      counts: { red: 0, yellow: 0, green: 0 },
      checks: [{
        check: "probe.error",
        status: "red",
        evidence,
        remediation: "用 zrig daemon logs 查看后台服务日志",
      }],
      repairPacket: [{
        step: 1,
        command: "用 zrig daemon logs 查看后台服务日志",
        rationale: evidence,
        safe: true,
        blocking: true,
      }],
    }, 500);
  }
});
