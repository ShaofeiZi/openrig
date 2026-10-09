// S10 (OPR.0.5.5.10) —— 作为后台服务内部子系统的 gateway。M1 §3 经 2026-08-26 修订
// （创始人 R2 下的桌面负责人修订）：gateway 在后台服务启动时以进程内方式运行——
// 已交付的组件（GatewayDispatcher + DispatchBuffer）原样复用，没有子进程，也没有
// gateway↔connector 套接字线路。spawn-gateway.ts / gateway-process*.ts / transport.ts 是
// 已退役的进程拆分形态，绝不能再获得调用方（第二个可部署物的「缺席」是契约红线）。
//
// 持久化是已交付的契约，不因重新归位而改变：一条决策在尝试投递之前先持久化到持久缓冲区
// （dispatcher 先入队），仅在投递层报告成功后才排出（进程内 ack），未 Ack 的决策在每次
// 子系统（重）启时重放——投递失败会被保留，绝不丢弃。
//
// 失败诚实性（mini-req 1）：start() 时的接线失败表现为 state=failed 并写明原因，在健康状态
// 表面可见——它绝不会抛进后台服务启动流程（一个坏掉的 gateway 绝不能拖垮后台服务），也绝不
// 会伪装成静默运行中。

import { DispatchBuffer } from "./dispatch-buffer.js";
import { GatewayDispatcher, type DispatchResult } from "./dispatcher.js";
import type { OutboundDecision } from "./protocol.js";

/** 进程内投递结果（镜像已退役 connector 的 DeliveryOutcome 形态，使 slice-11 的投递语义在
 *  切换时原样继承）。 */
export type SubsystemDeliveryOutcome = { ok: true } | { ok: false; class: string; detail?: string };
export type SubsystemDeliverFn = (decision: OutboundDecision) => Promise<SubsystemDeliveryOutcome>;

/** 接线步骤产出：活动的 dispatcher、它的拆除方法，以及（可选）触碰网络的服务
 *  （重放、出站轮询、套接字入站）。服务仅通过 startServices() 启动——由 index.ts 在绑定后调用
 *  （contextMonitor 模式），因此测试构建的后台服务（createDaemon 不带 serve）只组装接线、
 *  绝不外拨。 */
export interface GatewayWire {
  dispatcher: GatewayDispatcher;
  stop(): void;
  startServices?(): void;
  status?(): Record<string, unknown>;
}

export interface InProcessWireOpts {
  home: string;
  /** 平台投递接缝。在 relay 切换接上 Slack 之前，启动时传入一个诚实的「未接线」拒绝——
   *  调度会被持久保留，绝不静默丢弃。 */
  deliver: SubsystemDeliverFn;
  /** 投递层声明支持的 ops。已交付的 proof-9 轨道在进程内同样成立：未声明的 op 会被拒绝，
   *  绝不尝试。空 = 暂无可调度内容。 */
  ops?: string[];
  connectorId?: string;
  platform?: string;
  log?: (msg: string) => void;
}

/** 在进程内组装已交付的 dispatcher + 持久缓冲区。能力握手变成投递层的本地声明
 *  （同一个闭合契约，没有套接字）；投递后 ack 变成 deliver() resolve 出 ok。构建时的
 *  replayPending() 就是重启不丢失的那一段：上一次运行未 Ack 的决策重新进入投递。 */
export function buildInProcessWire(opts: InProcessWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const buffer = new DispatchBuffer(opts.home);
  const deliverAndAck = async (decision: OutboundDecision): Promise<void> => {
    let outcome: SubsystemDeliveryOutcome;
    try {
      outcome = await opts.deliver(decision);
    } catch (e) {
      outcome = { ok: false, class: "delivery-threw", detail: (e as Error).message };
    }
    if (outcome.ok) {
      dispatcher.onAck(decision.decisionId); // 仅在投递成功后才排出
    } else {
      log(`投递失败 ${decision.decisionId}（${outcome.class}${outcome.detail ? "：" + outcome.detail : ""}）——已保留待重放`);
    }
  };
  const dispatcher: GatewayDispatcher = new GatewayDispatcher({
    buffer,
    send: (decision) => { void deliverAndAck(decision); },
  });
  dispatcher.onCapability({
    kind: "capability",
    connectorId: opts.connectorId ?? "slack-subsystem",
    platform: opts.platform ?? "slack",
    protocolVersion: 1,
    ops: opts.ops ?? [],
  });
  return {
    dispatcher,
    stop: () => { /* 没有套接字、没有定时器——暂无需要拆除的东西 */ },
    // 重启不丢失：未 Ack 的决策重新进入投递——这是网络动作，因此走 startServices()（绑定后），
    // 绝不放在接线组装阶段。
    startServices: () => dispatcher.replayPending(),
  };
}

export type GatewaySubsystemState = "inactive" | "active" | "failed" | "stopped";

export interface GatewaySubsystemStatus {
  state: GatewaySubsystemState;
  /** 仅当 state=failed 时存在：写明的原因（诚实失败，绝不是静默死掉的 gateway）。 */
  reason?: string;
  activatedAt?: string;
  /** 等待投递/重放的持久未投递决策数（首次启动前为 undefined）。 */
  pendingDispatches?: number;
  /** connector 侧的活动观测；接线没有时绝不臆造。 */
  connector?: Record<string, unknown>;
}

export interface GatewaySubsystemDeps {
  home: string;
  /** 接线步骤。生产：() => buildInProcessWire({...})。可注入，便于测试制造接线失败并钉住
   *  诚实失败契约。 */
  wire: () => GatewayWire;
  log?: (msg: string) => void;
  now?: () => Date;
}

export class GatewaySubsystem {
  private state: GatewaySubsystemState = "inactive";
  private reason: string | undefined;
  private activatedAt: string | undefined;
  private wireHandle: GatewayWire | undefined;
  private servicesStarted = false;

  constructor(private readonly deps: GatewaySubsystemDeps) {}

  /** 在进程内激活。绝不抛异常：接线失败会记录 state=failed 并写明原因后返回——
   *  后台服务启动继续进行，健康状态表面如实反映。 */
  start(): void {
    if (this.state === "active") return;
    try {
      this.wireHandle = this.deps.wire();
      this.state = "active";
      this.reason = undefined;
      this.activatedAt = (this.deps.now?.() ?? new Date()).toISOString();
      this.deps.log?.("gateway 子系统已激活（进程内）");
    } catch (e) {
      this.state = "failed";
      this.reason = (e as Error).message;
      this.wireHandle = undefined;
      this.deps.log?.(`gateway 子系统激活失败：${this.reason}`);
    }
  }

  /** 启动接线的网络服务（重放、轮询器、套接字）。仅绑定后调用——index.ts 的监管树在
   *  contextMonitor.start() 旁调用本方法；测试构建的后台服务从不调用，因此组装一个后台服务
   *  绝不会外拨。幂等性由接线自身负责。 */
  startServices(): void {
    if (this.state !== "active") return;
    try {
      this.wireHandle?.startServices?.();
      this.servicesStarted = true;
    } catch (e) {
      // 服务启动失败是诚实的，但对已组装的接线不是致命的：调度仍会持久保留；
      // 健康状态表面写明这次降级。
      this.reason = `服务启动失败：${(e as Error).message}`;
      this.deps.log?.(`gateway 子系统服务启动失败：${(e as Error).message}`);
    }
  }

  /** 通过活动接线调度（未激活时诚实拒绝）。
   *  opts.decisionId：调用方提供的、在 episode 间稳定的持久身份
   *  （OPR.0.5.6.1 —— 延迟触发与摘要投递的重驱幂等键）。 */
  dispatch(op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }): DispatchResult {
    if (this.state !== "active" || !this.wireHandle) {
      return { ok: false, error: `调度被拒绝：gateway 子系统当前状态为 ${this.state}${this.reason ? `（${this.reason}）` : ""}` };
    }
    return this.wireHandle.dispatcher.dispatch(op, entityBindingRef, payload, opts);
  }

  status(): GatewaySubsystemStatus {
    const s: GatewaySubsystemStatus = { state: this.state };
    if (this.reason !== undefined) s.reason = this.reason;
    if (this.activatedAt !== undefined) s.activatedAt = this.activatedAt;
    if (this.state === "active" || this.state === "failed") {
      try {
        s.pendingDispatches = new DispatchBuffer(this.deps.home).pending().length;
      } catch { /* 缓冲区不可读——省略而非谎报 */ }
      const connector = this.wireHandle?.status?.();
      if (connector) s.connector = connector;
    }
    return s;
  }

  /** 「恢复或上报」的恢复一半：拆除并重跑接线。若服务此前是活动的（绑定后），重建的接线
   *  也会一并启动服务——配置切换（启用/禁用）无需重启后台服务即可生效。 */
  restart(): void {
    const resumeServices = this.servicesStarted;
    this.stop();
    this.state = "inactive";
    this.start();
    if (resumeServices) this.startServices();
  }

  stop(): void {
    try { this.wireHandle?.stop(); } catch { /* 尽力而为 */ }
    this.wireHandle = undefined;
    this.servicesStarted = false;
    if (this.state !== "failed") this.state = "stopped";
    this.deps.log?.("gateway 子系统已停止");
  }
}
