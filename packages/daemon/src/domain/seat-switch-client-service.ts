import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter, TmuxWindow, TmuxClient } from "../adapters/tmux.js";
import { SeatStatusService } from "./seat-status-service.js";

/**
 * OPR.0.4.3.26——席位恢复 switch-client 视图重定向。
 *
 * 把已附着的 tmux 客户端（人工终端 / CMUX 磁贴）指向席位的规范会话/窗口。
 * 它刻意只操作视图：仅依赖 `rigRepo`（通过 SeatStatusService 读取）和 `tmuxAdapter`
 *（探测与切换）。它不持有 SessionRegistry 写入表面、ClaimService 或 SeatHandoverService，
 * 也绝不调用 converge/reconcile，因此在结构上无法修改路由、绑定、会话、transcript 或节点身份。
 * 它作为独立步骤，组合在路由修复 verb（`reconcile-session` / seat handover）之后。
 */

const RECONCILE_GUIDANCE =
  "请先修复路由（zrig reconcile-session <session>，或 zrig seat handover <seat> ...），再重新运行 switch-client。switch-client 只重定向客户端视图，绝不修复路由。";

function attachGuidance(session: string): string {
  return `请先挂接客户端：tmux attach -t ${session}（或在 CMUX 中打开席位），再重新运行 switch-client。switch-client 绝不会打开新终端。`;
}

export interface SeatSwitchClientRequest {
  seatRef: string;
  /** 指定一个已附着客户端；存在多个客户端时必填。 */
  client?: string | null;
  /** 目标窗口索引；默认为 0（规范席位窗口）。 */
  toWindow?: number | null;
}

export interface SeatSwitchClientSuccess {
  seat_ref: string;
  session: string;
  window: number;
  target: string;
  client: string;
  /** 只操作视图的标记：switch-client 绝不修改路由、绑定或身份。 */
  mutated: false;
  retargeted: true;
}

interface ClientRef {
  name: string;
  session: string;
}

export type SeatSwitchClientResult =
  | { ok: true; result: SeatSwitchClientSuccess }
  | {
      ok: false;
      code:
        | "seat_ref_required"
        | "seat_not_found"
        | "seat_ambiguous"
        | "missing_canonical_session"
        | "session_not_found"
        | "window_not_found"
        | "no_client"
        | "ambiguous_client"
        | "client_not_found"
        | "switch_failed"
        | "tmux_probe_failed";
      message: string;
      guidance?: string;
      /** 已附着客户端；在歧义/未找到路径中返回，使操作员可用显式 --client 重试。 */
      clients?: ClientRef[];
      matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
    };

export class SeatSwitchClientService {
  private rigRepo: RigRepository;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: { rigRepo: RigRepository; tmuxAdapter: TmuxAdapter }) {
    this.rigRepo = deps.rigRepo;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  /** 如实的探测失败结果。tmux 适配器会有意重新抛出意外探测失败（权限/socket 错误）。
   * 此处每个探测（hasSession / listWindows / listClients）都通过本方法处理异常，
   * 以带失败操作名称的结构化 tmux_probe_failed（→ HTTP 502）呈现，绝不返回无结构的 500。 */
  private probeFailed(operation: string, err: unknown): SeatSwitchClientResult {
    return {
      ok: false,
      code: "tmux_probe_failed",
      message: `tmux ${operation} 探测失败：${err instanceof Error ? err.message : String(err)}`,
      guidance: RECONCILE_GUIDANCE,
    };
  }

  async switchClient(req: SeatSwitchClientRequest): Promise<SeatSwitchClientResult> {
    // 1. 只读解析席位 -> 规范会话，不修改绑定。
    const statusService = new SeatStatusService({ rigRepo: this.rigRepo });
    const status = statusService.getStatus(req.seatRef);
    if (!status.ok) {
      // 逐字传播只读解析错误（seat_ref_required / seat_not_found / seat_ambiguous，
      // 包括歧义匹配列表）。
      if (status.code === "seat_ambiguous") {
        return { ok: false, code: "seat_ambiguous", message: status.message, guidance: status.guidance, matches: status.matches };
      }
      return { ok: false, code: status.code, message: status.message, guidance: status.guidance };
    }

    const session = status.status.current_occupant;
    if (!session) {
      return {
        ok: false,
        code: "missing_canonical_session",
        message: `席位 "${req.seatRef}" 没有可查看的规范 tmux 会话。`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    // 2. 只读探测规范会话；真实探测失败（权限等）如实呈现，不吞掉。
    let sessionLive: boolean;
    try {
      sessionLive = await this.tmuxAdapter.hasSession(session);
    } catch (err) {
      return this.probeFailed(`has-session for "${session}"`, err);
    }
    if (!sessionLive) {
      return {
        ok: false,
        code: "session_not_found",
        message: `席位 "${req.seatRef}" 的规范会话 "${session}" 当前未存活。`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    // 3. 解析目标窗口。默认值为 0（规范席位窗口）。显式 --to-window 会依据活跃会话校验，
    //    使操作员得到可执行指引，而不是原始 tmux 失败。
    const windowIndex = req.toWindow ?? 0;
    if (req.toWindow != null) {
      let windows: TmuxWindow[];
      try {
        windows = await this.tmuxAdapter.listWindows(session);
      } catch (err) {
        return this.probeFailed(`list-windows for "${session}"`, err);
      }
      if (!windows.some((w) => w.index === req.toWindow)) {
        const available = windows.map((w) => w.index).join(", ") || "无";
        return {
          ok: false,
          code: "window_not_found",
          message: `会话 "${session}" 中不存在窗口 ${req.toWindow}。`,
          guidance: `可用窗口：${available}。`,
        };
      }
    }

    // 4. 选择要重定向的已附着客户端。
    let clients: TmuxClient[];
    try {
      clients = await this.tmuxAdapter.listClients();
    } catch (err) {
      return this.probeFailed("list-clients", err);
    }
    if (clients.length === 0) {
      return {
        ok: false,
        code: "no_client",
        message: `没有可为席位 "${req.seatRef}" 重定向的已挂接 tmux 客户端。`,
        guidance: attachGuidance(session),
      };
    }

    let targetClient: string;
    if (req.client) {
      const match = clients.find((cl) => cl.name === req.client);
      if (!match) {
        return {
          ok: false,
          code: "client_not_found",
          message: `没有名为 "${req.client}" 的已挂接客户端。`,
          guidance: "请从已挂接客户端列表中选择一个 --client 后重试。",
          clients: clients.map((cl) => ({ name: cl.name, session: cl.session })),
        };
      }
      targetClient = match.name;
    } else if (clients.length === 1) {
      targetClient = clients[0]!.name;
    } else {
      // 绝不静默重定向多个用户视图中的任意一个，必须显式选择 --client。
      return {
        ok: false,
        code: "ambiguous_client",
        message: `存在多个已挂接客户端；请用 --client <name> 指定一个。`,
        guidance: "请将 --client 设为某个已挂接客户端后重试。",
        clients: clients.map((cl) => ({ name: cl.name, session: cl.session })),
      };
    }

    // 5. 重定向客户端视图；这是唯一副作用，不修改 OpenRig 路由或身份。
    const target = `${session}:${windowIndex}`;
    const switchResult = await this.tmuxAdapter.switchClient(targetClient, target);
    if (!switchResult.ok) {
      return {
        ok: false,
        code: "switch_failed",
        message: `tmux switch-client 失败：${switchResult.message}`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    return {
      ok: true,
      result: {
        seat_ref: req.seatRef,
        session,
        window: windowIndex,
        target,
        client: targetClient,
        mutated: false,
        retargeted: true,
      },
    };
  }
}
