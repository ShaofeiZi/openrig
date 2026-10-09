import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { TranscriptIngestHealth, TranscriptStore } from "../domain/transcript-store.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { startTmuxTranscriptCapture } from "../domain/transcript-capture.js";
import { redactTranscriptContent } from "../domain/transcript-redaction.js";

interface SessionRow {
  node_id: string;
}

interface NodeRow {
  rig_id: string;
  runtime: string | null;
}

interface BindingRow {
  attachment_type: string | null;
  tmux_session: string | null;
}

const CAPTURE_WARMUP_MS = 150;

function resolveSessionToRig(
  db: Database.Database,
  rigRepo: RigRepository,
  sessionName: string,
): { rigName: string; nodeId: string; runtime: string | null } | { error: string; status: number } {
  // 找出同名的所有会话以检测歧义
  const sessionRows = db
    .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC")
    .all(sessionName) as SessionRow[];

  if (sessionRows.length === 0) {
    return {
      error: `未找到会话 '${sessionName}'。用 zrig ps --nodes 查看会话名`,
      status: 404,
    };
  }

  // 收集所有匹配会话的不同工作组名
  const rigNames = new Set<string>();
  for (const row of sessionRows) {
    const nodeRow = db
      .prepare("SELECT rig_id, runtime FROM nodes WHERE id = ?")
      .get(row.node_id) as NodeRow | undefined;
    if (nodeRow) {
      const rig = rigRepo.getRig(nodeRow.rig_id);
      if (rig) rigNames.add(rig.rig.name);
    }
  }

  if (rigNames.size === 0) {
    return {
      error: `未找到会话 '${sessionName}'。用 zrig ps --nodes 查看会话名`,
      status: 404,
    };
  }

  if (rigNames.size > 1) {
    const names = Array.from(rigNames).join(", ");
    return {
      error: `会话 '${sessionName}' 有歧义——出现在以下工作组：${names}。请使用唯一会话名或指定工作组`,
      status: 409,
    };
  }

  const selectedNode = db
    .prepare("SELECT rig_id, runtime FROM nodes WHERE id = ?")
    .get(sessionRows[0]!.node_id) as NodeRow;
  return {
    rigName: rigNames.values().next().value!,
    nodeId: sessionRows[0]!.node_id,
    runtime: selectedNode.runtime,
  };
}

async function tryStartCaptureForSession(
  db: Database.Database,
  transcriptStore: TranscriptStore,
  tmuxAdapter: TmuxAdapter | undefined,
  rigName: string,
  nodeId: string,
  sessionName: string,
): Promise<boolean> {
  const binding = db
    .prepare("SELECT attachment_type, tmux_session FROM bindings WHERE node_id = ?")
    .get(nodeId) as BindingRow | undefined;
  if (!binding) return false;
  if ((binding.attachment_type ?? "tmux") !== "tmux") return false;
  if (!binding.tmux_session || binding.tmux_session !== sessionName) return false;
  const result = await startTmuxTranscriptCapture(tmuxAdapter, transcriptStore, rigName, sessionName);
  return result.started;
}

type RouteIngestHealth = TranscriptIngestHealth & { runtime: string | null };

async function ensureTranscriptIngest(
  db: Database.Database,
  transcriptStore: TranscriptStore,
  tmuxAdapter: TmuxAdapter | undefined,
  resolution: { rigName: string; nodeId: string; runtime: string | null },
  sessionName: string,
): Promise<{ health: RouteIngestHealth; started: boolean }> {
  let health = transcriptStore.getIngestHealth(resolution.rigName, sessionName);
  let started = false;
  if (health.state !== "live") {
    started = await tryStartCaptureForSession(
      db,
      transcriptStore,
      tmuxAdapter,
      resolution.rigName,
      resolution.nodeId,
      sessionName,
    );
    if (started) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_WARMUP_MS));
      health = transcriptStore.getIngestHealth(resolution.rigName, sessionName);
    }
  }
  return { health: { ...health, runtime: resolution.runtime }, started };
}

function transcriptIngestError(sessionName: string, health: RouteIngestHealth, started = false): string {
  const runtime = health.runtime ?? "未知运行时";
  if (health.reason === "capture_missing") {
    if (started) {
      return `'${sessionName}' 暂无 transcript（${runtime}）。transcript 捕获原本缺失，现已启动。等会话产出新输出后重试。`;
    }
    return `'${sessionName}' 无 transcript（${runtime}；摄入不可用：${health.reason}）。transcript 会在下次工作组启动时自动开始。`;
  }
  return `'${sessionName}' 的 transcript 摄入已降级（${runtime}；state=${health.state}；reason=${health.reason}）。不要仅凭此 transcript 断定会话安静。`;
}

export function transcriptRoutes(): Hono {
  const router = new Hono();

  router.get("/:session/tail", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
    const sessionName = c.req.param("session");
    const rawLines = parseInt(c.req.query("lines") ?? "50", 10);
    const lines = isNaN(rawLines) || rawLines < 1 ? 50 : rawLines;

    if (!transcriptStore?.enabled) {
      return c.json(
        { error: "transcript 已禁用。用 zrig config set transcripts.enabled true 启用" },
        404,
      );
    }

    const resolution = resolveSessionToRig(db, rigRepo, sessionName);
    if ("error" in resolution) {
      return c.json({ error: resolution.error }, resolution.status as 404);
    }

    const ingest = await ensureTranscriptIngest(
      db, transcriptStore, tmuxAdapter, resolution, sessionName,
    );
    const ingestHealth = ingest.health;
    if (ingestHealth.state !== "live") {
      return c.json(
        { error: transcriptIngestError(sessionName, ingestHealth, ingest.started), ingestHealth },
        ingestHealth.state === "unavailable" ? 404 : 503,
      );
    }

    const content = transcriptStore.readTail(resolution.rigName, sessionName, lines);
    if (content === null || content === "") {
      const emptyHealth: RouteIngestHealth = {
        ...ingestHealth,
        state: "degraded",
        reason: "capture_empty",
      };
      return c.json(
        { error: transcriptIngestError(sessionName, emptyHealth), ingestHealth: emptyHealth },
        503,
      );
    }

    return c.json({ session: sessionName, lines, content, ingestHealth });
  });

  router.get("/:session/grep", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
    const sessionName = c.req.param("session");
    const pattern = c.req.query("pattern");

    if (!pattern) {
      return c.json({ error: "缺少必填查询参数：pattern" }, 400);
    }

    // 预校验正则
    try {
      new RegExp(pattern);
    } catch (err) {
      return c.json(
        { error: `非法 grep 模式：${(err as Error).message}` },
        400,
      );
    }

    if (!transcriptStore?.enabled) {
      return c.json(
        { error: "transcript 已禁用。用 zrig config set transcripts.enabled true 启用" },
        404,
      );
    }

    const resolution = resolveSessionToRig(db, rigRepo, sessionName);
    if ("error" in resolution) {
      return c.json({ error: resolution.error }, resolution.status as 404);
    }

    const ingest = await ensureTranscriptIngest(
      db, transcriptStore, tmuxAdapter, resolution, sessionName,
    );
    const ingestHealth = ingest.health;
    if (ingestHealth.state !== "live") {
      return c.json(
        { error: transcriptIngestError(sessionName, ingestHealth, ingest.started), ingestHealth },
        ingestHealth.state === "unavailable" ? 404 : 503,
      );
    }

    const matches = transcriptStore.grep(resolution.rigName, sessionName, pattern);
    if (matches === null) {
      return c.json({ error: transcriptIngestError(sessionName, ingestHealth), ingestHealth }, 503);
    }

    return c.json({ session: sessionName, pattern, matches, ingestHealth });
  });

  // GET /:session/full——返回一个会话的完整 transcript 内容。
  //
  // 按 orch 决策 approved-option-a（escalation
  // qitem-20260502020833-68e4eca3）：本路由沿用既有 tail/grep 姿态
  // （开放路由，后台服务本地信任边界）。不强制会话范围鉴权，因为今天后台服务里
  // 还没有调用方身份原语。路由级脱敏（M1 contract § 4 / openrig-v0 策略）
  // 是保护性原语——凭据形状的模式在序列化之前从线路负载中 scrub 掉。
  //
  // 未来的 slice 可能在 tail/grep/full 之上叠加一套一致的 transcript 读取鉴权策略；
  // 那部分工作不在 M2c-Daemon 范围内，作为 Product Lab 后续信号跟踪。
  router.get("/:session/full", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
    const sessionName = c.req.param("session");

    if (!transcriptStore?.enabled) {
      return c.json(
        { error: "transcript 已禁用。用 zrig config set transcripts.enabled true 启用" },
        404,
      );
    }

    const resolution = resolveSessionToRig(db, rigRepo, sessionName);
    if ("error" in resolution) {
      return c.json({ error: resolution.error }, resolution.status as 404);
    }

    const ingest = await ensureTranscriptIngest(
      db, transcriptStore, tmuxAdapter, resolution, sessionName,
    );
    const ingestHealth = ingest.health;
    if (ingestHealth.state !== "live") {
      return c.json(
        { error: transcriptIngestError(sessionName, ingestHealth, ingest.started), ingestHealth },
        ingestHealth.state === "unavailable" ? 404 : 503,
      );
    }

    const raw = transcriptStore.readFull(resolution.rigName, sessionName);
    if (raw === null || raw === "") {
      const emptyHealth: RouteIngestHealth = { ...ingestHealth, state: "degraded", reason: "capture_empty" };
      return c.json({ error: transcriptIngestError(sessionName, emptyHealth), ingestHealth: emptyHealth }, 503);
    }

    // 序列化之前应用路由级脱敏。按 Quality Lesson v9 + orch 决策
    // approved-option-a：线路负载必须已脱敏；不要依赖客户端脱敏。
    const content = redactTranscriptContent(raw);
    return c.json({ session: sessionName, content, ingestHealth });
  });

  return router;
}
