import type { DaemonClient } from "../client.js";

/**
 * OPR.0.4.6.WF3 FR-1——`rig workflow run` 与 `rig workflow watch` 背后共用的 follow
 * 引擎：两个动词，一个渲染器（argo 形状：attach 时与实时用同一份渲染）。
 *
 * 传输：已交付的 workflow SSE 端点（`GET /api/workflow/sse`），用仓内
 * chatroom reader 模式消费（fetch + event-stream 行解码）。零后台服务改动
 *（BR-2）——本文件只读。
 *
 * attach 竞态（arch R2，先快照再流）：先打开流，再渲染状态快照（`/trace`），
 * 然后实时事件流入。与快照里已有 trail 行重复的事件按 priorQitemId 去重，
 * 这样在 attach 之前就关闭的快速早期步骤仍然只显示一次。
 *
 * 退出码（arch n1——结果码与错误码分离）：
 *   0 = 工作流已完成
 *   3 = 工作流失败（结果即退出码的 kubectl 默认——失败的工作流就是失败的命令；
 *       永不与已交付的 1=4xx / 2=5xx 传输码冲突）
 */
export const EXIT_WORKFLOW_FAILED = 3;

/** follow 运行解析到的终态。 */
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export interface FollowInstanceView {
  instanceId: string;
  workflowName?: string;
  status: string;
  currentStepId?: string | null;
  currentFrontier?: string[];
}

export interface FollowTrailRow {
  stepId: string;
  stepRole?: string;
  closedAt?: string;
  closureReason: string;
  actorSession: string;
  nextQitemId?: string | null;
  priorQitemId: string;
}

interface WorkflowEvent {
  type: string;
  instanceId?: string;
  stepId?: string;
  closureReason?: string;
  actorSession?: string;
  priorQitemId?: string;
  nextQitemId?: string;
  nextOwner?: string;
  nextStepId?: string;
  workflowName?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface FollowIo {
  /** stdout 行接收器（测试注入；默认 console.log）。 */
  out: (line: string) => void;
  /** stderr 行接收器，用于如实报告传输状态。 */
  err: (line: string) => void;
  /** sleep 注入，让测试不等待真实墙钟时间。 */
  sleep: (ms: number) => Promise<void>;
  /** SSE 段的 fetch 注入（测试 stub 流）。 */
  fetchImpl: typeof fetch;
}

export function realFollowIo(): FollowIo {
  return {
    out: (line) => console.log(line),
    err: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl: fetch,
  };
}

export interface FollowOptions {
  json: boolean;
  io?: FollowIo;
  /** 降级到轮询兜底前的 SSE 重连次数。 */
  maxReconnects?: number;
  /** 轮询兜底间隔（毫秒）。 */
  pollIntervalMs?: number;
}

const STATUS_GLYPH: Record<string, string> = {
  completed: "✔",
  failed: "✖",
  active: "●",
  waiting: "◐",
};

function glyphFor(status: string): string {
  return STATUS_GLYPH[status] ?? "●";
}

function renderTrailRow(row: FollowTrailRow): string {
  const exitGlyph = row.closureReason === "failed" ? "✖" : "✔";
  const next = row.nextQitemId ? ` → ${row.nextQitemId}` : "";
  return `  ${exitGlyph} ${row.stepId}  ${row.closureReason}  by ${row.actorSession}${next}`;
}

function renderEvent(event: WorkflowEvent): string | null {
  switch (event.type) {
    case "workflow.instantiated":
      return `  ● 实例 ${event.instanceId ?? ""} 已创建${event.workflowName ? `（${event.workflowName}）` : ""}`;
    case "workflow.step_closed":
      return `  ${event.closureReason === "failed" ? "✖" : "✔"} ${event.stepId ?? "(步骤)"}  ${event.closureReason ?? ""}  by ${event.actorSession ?? "(未知)"}`;
    case "workflow.next_qitem_projected":
      return `  → ${event.nextStepId ?? "(下一步)"}  负责人 ${event.nextOwner ?? "(未解析)"}  包 ${event.nextQitemId ?? ""}`;
    case "workflow.completed":
      return `  ✔ 工作流已完成`;
    case "workflow.failed":
      return `  ✖ 工作流失败：${event.reason ?? "（未记录原因）"}`;
    default:
      // routing_table_changed 与未来的增量类型渲染为中性单行，
      // 而不是被静默丢弃。
      return `  · ${event.type}`;
  }
}

/** 结果 → 进程退出码，按 FR-1 契约。 */
export function outcomeExitCode(status: string): number {
  if (status === "failed") return EXIT_WORKFLOW_FAILED;
  return 0;
}

interface SnapshotResult {
  instance: FollowInstanceView;
  trail: FollowTrailRow[];
}

async function fetchSnapshot(
  client: DaemonClient,
  instanceId: string,
): Promise<{ ok: true; snapshot: SnapshotResult } | { ok: false; status: number; body: unknown }> {
  const res = await client.get<{ instance?: FollowInstanceView; trail?: FollowTrailRow[] }>(
    `/api/workflow/${encodeURIComponent(instanceId)}/trace`,
  );
  if (res.status >= 400 || !res.data?.instance) {
    return { ok: false, status: res.status, body: res.data };
  }
  return { ok: true, snapshot: { instance: res.data.instance, trail: res.data.trail ?? [] } };
}

function renderSnapshot(snapshot: SnapshotResult, io: FollowIo, json: boolean): void {
  if (json) {
    io.out(JSON.stringify({ type: "snapshot", instance: snapshot.instance, trail: snapshot.trail }));
    return;
  }
  const inst = snapshot.instance;
  io.out(`${glyphFor(inst.status)} ${inst.instanceId}${inst.workflowName ? `  ${inst.workflowName}` : ""}  status=${inst.status}`);
  for (const row of snapshot.trail) io.out(renderTrailRow(row));
  if (inst.currentStepId) {
    io.out(`  ▸ at step ${inst.currentStepId}  frontier=[${(inst.currentFrontier ?? []).join(", ")}]`);
  }
}

/**
 * follow 一个实例直到终态。返回调用方应设置的退出码
 *（0 完成 / 3 失败 / 1 传输 4xx / 2 传输 5xx）。流断开时绝不抛错——
 * 按 chatroom 先例如实降级（重连提示 → 轮询兜底提示）：渲染可以降级，
 * 但绝不静默冻结。
 */
export async function followInstance(
  client: DaemonClient,
  instanceId: string,
  opts: FollowOptions,
): Promise<number> {
  const io = opts.io ?? realFollowIo();
  const maxReconnects = opts.maxReconnects ?? 3;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  // Walk-caught（VM 迭代 2）：返回时若不中止 SSE 连接，打开的 socket
  // 会让 node 事件循环保持存活，进程在终态事件之后挂起约几分钟才退出——
  // kubectl 风格的动词必须在出结果时立刻退出。每条返回路径都通过下面的
  // finally 中止。
  const aborter = new AbortController();
  try {
    // 1. 先打开流（arch R2），这样快照与 attach 之间不会漏掉事件。
    //    reader 会缓冲事件，直到快照渲染完。
    const sseUrl = `${client.baseUrl}/api/workflow/sse`;
    let streamRes: Response | null = null;
    try {
      streamRes = await io.fetchImpl(sseUrl, {
        headers: { Accept: "text/event-stream" },
        signal: aborter.signal,
      });
      if (!streamRes.ok || !streamRes.body) streamRes = null;
    } catch {
      streamRes = null;
    }

    // 2. 快照 + 渲染。
    const snap = await fetchSnapshot(client, instanceId);
    if (!snap.ok) {
      io.out(JSON.stringify(snap.body ?? { error: "trace_failed" }, null, opts.json ? 0 : 2));
      return snap.status >= 500 ? 2 : 1;
    }
    renderSnapshot(snap.snapshot, io, opts.json);
    if (TERMINAL_STATUSES.has(snap.snapshot.instance.status)) {
      return outcomeExitCode(snap.snapshot.instance.status);
    }

    // 去重守卫：快照已渲染的 trail 行，在（已打开的）流重放它们的事件时
    // 不得再次渲染。
    const seenClosures = new Set(snap.snapshot.trail.map((row) => row.priorQitemId));

    let reconnectsLeft = maxReconnects;
    // 3. 带如实降级的流循环。
    while (true) {
      if (streamRes?.body) {
        const outcome = await consumeStream(streamRes.body, instanceId, seenClosures, io, opts.json);
        if (outcome !== null) return outcome;
        // 流结束但没有终态事件——断开路径。
        streamRes = null;
      }
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1;
        io.err(`流已断开——重连中（${maxReconnects - reconnectsLeft}/${maxReconnects}）`);
        try {
          const retry = await io.fetchImpl(sseUrl, {
            headers: { Accept: "text/event-stream" },
            signal: aborter.signal,
          });
          if (retry.ok && retry.body) {
            streamRes = retry;
            continue;
          }
        } catch {
          // 落到下一次重连 / 轮询兜底
        }
        continue;
      }
    // 4. 轮询兜底——会提示，绝不静默（chatroom 规则）。
    io.err(`流不可用——降级为每 ${Math.round(pollIntervalMs / 1000)}s 轮询兜底`);
    while (true) {
      await io.sleep(pollIntervalMs);
      const poll = await fetchSnapshot(client, instanceId);
      if (!poll.ok) {
        io.out(JSON.stringify(poll.body ?? { error: "poll_failed" }, null, opts.json ? 0 : 2));
        return poll.status >= 500 ? 2 : 1;
      }
      // 只渲染尚未见过的 trail 行，保证 exactly-once。
      for (const row of poll.snapshot.trail) {
        if (seenClosures.has(row.priorQitemId)) continue;
        seenClosures.add(row.priorQitemId);
        if (opts.json) io.out(JSON.stringify({ type: "trail", row }));
        else io.out(renderTrailRow(row));
      }
      if (TERMINAL_STATUSES.has(poll.snapshot.instance.status)) {
        if (opts.json) io.out(JSON.stringify({ type: "terminal", status: poll.snapshot.instance.status }));
        else io.out(`  ${glyphFor(poll.snapshot.instance.status)} 工作流 ${poll.snapshot.instance.status}`);
        return outcomeExitCode(poll.snapshot.instance.status);
      }
    }
    }
  } finally {
    // 杀掉 SSE socket，让进程在出结果时立刻退出
    //（walk-caught 挂起：未中止的 keep-alive 在 workflow.completed 之后
    // 把事件循环撑了几分钟）。
    aborter.abort();
  }
}

/**
 * 消费一个 SSE body，直到该实例出现终态事件（→ 退出码）
 * 或流结束（→ null：调用方重连/降级）。
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  instanceId: string,
  seenClosures: Set<string>,
  io: FollowIo,
  json: boolean,
): Promise<number | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let event: WorkflowEvent;
        try {
          event = JSON.parse(line.slice(5).trim()) as WorkflowEvent;
        } catch {
          continue; // 畸形 data 行——跳过（chatroom 先例）
        }
        if (event.instanceId !== instanceId) continue;
        if (event.type === "workflow.step_closed" && typeof event.priorQitemId === "string") {
          if (seenClosures.has(event.priorQitemId)) continue; // 快照已显示
          seenClosures.add(event.priorQitemId);
        }
        if (json) {
          io.out(JSON.stringify(event));
        } else {
          const rendered = renderEvent(event);
          if (rendered !== null) io.out(rendered);
        }
        if (event.type === "workflow.completed") return 0;
        if (event.type === "workflow.failed") return EXIT_WORKFLOW_FAILED;
      }
    }
  } catch {
    return null; // 读错误 = 断开；调用方如实处理
  } finally {
    reader.releaseLock();
  }
}
