// B1 ROUND 2——操作者拥有的舰队恢复生命周期。r2 证明先前路径将整个
// 生命周期委托给缓冲子命令（`execFile rig crash-cart restore-fleet`），因此 TUI
// 没有尝试 ID，无法在运行中渲染进度（两个 GET 在飞，输出仅在退出时），且
// 无法到达取消端点。此驱动使 TUI 拥有它：启动 → 轮询 → 取消，每次轮询发出
// 一帧，使座舱从汇总流渲染进度（计划 R2/R4），并在操作者请求时到达取消端点（计划 R8）。
// 后台服务的异步 on-commit 路由（r1 已清除）不变——这是缺失的客户端消费者。
import type { RestoreFleetStatus } from "../daemon-client.js";
import type { TriageRow } from "./triage.js";

/** 生命周期需要的后台服务表面——DaemonClient 的结构子集（测试可注入）。 */
export interface RestoreLifecycleClient {
  restoreFleet(): Promise<{ fleetAttemptId: string }>;
  restoreFleetStatus(id: string): Promise<RestoreFleetStatus>;
  cancelRestoreFleet(id: string): Promise<unknown>;
}

/** 生命周期的一个渲染帧——轮询的状态加上保留的尝试 ID + 阶段。
 *  `detached` = 驱动停止轮询（达到轮询上限或重复轮询错误）而恢复仍在
 *  后台服务上运行——显式、可操作的状态（按 ID 重新附着/取消），绝不
 *  是冻结的 `running` 屏幕且取消键失效。 */
export interface RestoreFrame extends RestoreFleetStatus {
  attemptId: string;
  phase: "running" | "done" | "detached";
}

/** 运行视图的按工作组进度行（到目前为止汇总序列中每个工作组一行）。 */
export interface RestoreProgressRow {
  rigId: string;
  outcome: string;
}

/** 恢复生命周期表面的渲染模型——运行中显示进度，完成时显示汇总 +
 *  可键盘遍历的诊断列表。纯从一帧构建，使渲染保持可测试。 */
export interface RestoreLifecycleVM {
  phase: "running" | "done" | "detached";
  cancelled: boolean;
  verdict: string;
  counts: RestoreFleetStatus["rollup"]["counts"];
  progress: RestoreProgressRow[];
  /** 诊断列表（待关注席位 + 未尝试工作组）作为已发布 TriageRow[]——喂给 renderTriage。 */
  triage: TriageRow[];
  /** 保留的尝试 ID——分离视图需要它用于重新附着/直接取消可用性。 */
  attemptId: string;
}

/** 将生命周期帧适配到渲染 VM。诊断列表是两个诚实来源的并集，
 *  每个在自己行上携带其确切需要（绝不裁剪的一行摘要）：按席位的
 *  待关注行（Claude 选择器 / Codex 认证 / 等待决策），红色；以及
 *  带有补救的未尝试工作组（无可用快照 / 已取消），黄色（警告，而非失败席位）。 */
export function buildRestoreLifecycleVM(frame: RestoreFrame): RestoreLifecycleVM {
  const attentionRows: TriageRow[] = frame.rollup.attention_required.map((a) => ({
    seat: `${a.seat}@${a.rigId}`,
    check: "resume",
    status: "red",
    need: a.need,
    evidence: a.need,
    remediationSafe: false,
  }));
  const notAttemptedRows: TriageRow[] = frame.rollup.sequence
    .filter((r) => r.outcome === "not_attempted" && (r.remediation || r.reason))
    .map((r) => ({
      seat: r.rigId,
      check: "snapshot",
      status: "yellow",
      need: r.remediation ?? r.reason ?? "未尝试",
      evidence: r.reason ?? "",
      remediationSafe: false,
    }));
  return {
    phase: frame.phase,
    cancelled: frame.cancelled,
    verdict: frame.verdict,
    counts: frame.rollup.counts,
    progress: frame.rollup.sequence.map((r) => ({ rigId: r.rigId, outcome: r.outcome })),
    triage: [...attentionRows, ...notAttemptedRows],
    attemptId: frame.attemptId,
  };
}

export interface RestoreLifecycleDeps {
  client: RestoreLifecycleClient;
  /** 每次轮询调用（运行中 + 分离帧包含）——TUI 渲染的进度流。 */
  onFrame: (frame: RestoreFrame) => void;
  /** 每 tick 轮询；为 true 时驱动 POST 一次取消（在下一个工作组前停止）。 */
  isCancelRequested: () => boolean;
  /** 重新附着到现有尝试（跳过启动）——分离视图的 `r` 重新进入循环。 */
  attemptId?: string;
  /** 测试中注入（无真实延迟）；生产使用 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** 分离前容忍的连续轮询错误数（瞬时抖动绝不能杀死驱动）。 */
  maxConsecutiveErrors?: number;
}

/** 从 TUI 驱动一次舰队恢复：启动（或重新附着），保留尝试 ID，每次轮询发出一帧
 *  （运行中可观察），操作者请求时请求取消，完成时 resolve。操作者生命周期依赖的
 *  两个保证：
 *   - 瞬时轮询错误绝不结束生命周期——容忍并重试；仅
 *     连续 `maxConsecutiveErrors` 次（真正不可达的后台服务）才分离。
 *   - 达到轮询上限分离（阶段 "detached"），绝不返回冻结的 "running"
 *     帧——因此调用方绝不渲染取消键失效的看似实时屏幕。分离
 *     帧是显式、可操作的状态：调用方通过保留的 ID 重新附着或取消。 */
export async function driveRestoreLifecycle(deps: RestoreLifecycleDeps): Promise<RestoreFrame> {
  const fleetAttemptId = deps.attemptId ?? (await deps.client.restoreFleet()).fleetAttemptId;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? 400;
  const maxPolls = deps.maxPolls ?? 4500; // 慷慨——真实舰队恢复受后台服务工作限制
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? 5;
  let cancelSent = false;
  let consecutiveErrors = 0;
  let last: RestoreFleetStatus | undefined;
  const detached = (): RestoreFrame => ({
    ...(last ?? { done: false, cancelled: false, verdict: "none_attempted", rollup: { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] } }),
    done: false,
    attemptId: fleetAttemptId,
    phase: "detached",
  });
  for (let i = 0; i < maxPolls; i++) {
    if (deps.isCancelRequested() && !cancelSent) {
      cancelSent = true;
      try {
        await deps.client.cancelRestoreFleet(fleetAttemptId); // 到达存在的端点
      } catch {
        cancelSent = false; // 失败的取消 POST 可在下一 tick 重试（绝不吞掉操作者意图）
      }
    }
    let status: RestoreFleetStatus;
    try {
      status = await deps.client.restoreFleetStatus(fleetAttemptId);
      consecutiveErrors = 0; // 好的轮询清除瞬时错误连击
    } catch {
      // 瞬时轮询失败（r1 细化 2）：容忍，绝不因一次结束生命周期。仅
      // 持续连击（真正不可达的后台服务）分离到可操作的重新附着状态。
      if (++consecutiveErrors >= maxConsecutiveErrors) {
        const frame = detached();
        deps.onFrame(frame);
        return frame;
      }
      await sleep(interval);
      continue;
    }
    const frame: RestoreFrame = { ...status, attemptId: fleetAttemptId, phase: status.done ? "done" : "running" };
    deps.onFrame(frame); // 每次轮询一帧——操作者在完成前看到进度
    last = status;
    if (status.done) return frame;
    await sleep(interval);
  }
  // 轮询上限：分离（绝不冻结的 "running" 帧——r1 细化 1）。恢复在
  // 后台服务上继续；调用方从此显式状态提供重新附着/按 ID 取消。
  const frame = detached();
  deps.onFrame(frame);
  return frame;
}
