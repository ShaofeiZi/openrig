import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";

/** 等待前捕获 binding。绝不将旧 operation 重新绑定到新 occupant。 */
export interface GuardTarget {
  nodeId: string;
  session: string;
  occupant: string | null;
  pane: string | null;
}

interface Lease {
  target: GuardTarget;
  active: boolean;
  origin: "automatic" | "human";
  lifecycle?: boolean;
}

export class DeliveryGuardError extends Error {
  constructor(readonly code: string, message: string) { super(message); }

  // Hono error protocol 也会在 lifecycle route 上保留此 typed refusal。
  getResponse(): Response {
    return Response.json({ ok: false, code: this.code, error: this.message }, { status: 409 });
  }
}

export interface GuardPreference {
  nodeId: string;
  desired: boolean;
  effective: boolean;
  pending: boolean;
}

/** preference activation、delivery 与 write lifecycle 共用一个 serialization domain。
 * 不通过 timer 排空 held message。async context 携带 lease 穿过嵌套 adapter；active=false
 * 防止 detached task 在 operation 结束后继续持有权限。
 */
export class SeatDeliveryGuard {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scope = new AsyncLocalStorage<Map<string, Lease>>();
  private readonly humanLeases = new Set<Lease>();

  constructor(
    readonly db: Database.Database,
    private readonly resolve: (target: string) => GuardTarget | null,
  ) {}

  /** 仅用于 startup，在公开 route 或启动 writer 前执行。已停止 operation 无法保留内存 lease。
   * 已持久化的 desired protection 在新 boundary 生效。 */
  recoverActivation(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE seat_delivery_guards SET effective = desired WHERE effective != desired").run();
      this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE effective_at IS NULL")
        .run(new Date().toISOString());
    })();
  }

  preference(nodeId: string): GuardPreference {
    const row = this.db.prepare("SELECT desired, effective FROM seat_delivery_guards WHERE node_id = ?")
      .get(nodeId) as { desired: number; effective: number } | undefined;
    return { nodeId, desired: !!row?.desired, effective: !!row?.effective, pending: row !== undefined && row.desired !== row.effective };
  }

  maybeTarget(name: string): GuardTarget | null { return this.resolve(name); }

  target(name: string): GuardTarget {
    const target = this.resolve(name);
    if (!target) throw new DeliveryGuardError("guard_target_unknown", `无法确定 managed input target ${name}；未写入任何 input。`);
    return target;
  }

  private same(a: GuardTarget, b: GuardTarget): boolean {
    return a.nodeId === b.nodeId && a.session === b.session && a.occupant === b.occupant && a.pane === b.pane;
  }

  private async serial<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(nodeId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = before.then(() => done);
    this.tails.set(nodeId, tail);
    await before;
    try { return await fn(); }
    finally { release(); if (this.tails.get(nodeId) === tail) this.tails.delete(nodeId); }
  }

  async set(nodeId: string, enabled: boolean, actor: string, reason: string, timeoutMs = 2000): Promise<GuardPreference> {
    if (!actor.trim() || !reason.trim()) throw new DeliveryGuardError("guard_reason_required", "必须提供 actor 与 reason。");
    const at = new Date().toISOString();
    const change = this.db.transaction(() => {
      const old = this.preference(nodeId);
      this.db.prepare(`INSERT INTO seat_delivery_guards(node_id, desired, effective, actor, reason, changed_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET
        desired=excluded.desired, actor=excluded.actor, reason=excluded.reason, changed_at=excluded.changed_at`)
        .run(nodeId, Number(enabled), Number(old.effective), actor, reason, at);
      return this.db.prepare(`INSERT INTO seat_delivery_guard_changes(node_id, desired, previous_desired, previous_effective, actor, reason, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nodeId, Number(enabled), Number(old.desired), Number(old.effective), actor, reason, at).lastInsertRowid;
    })();
    const activation = this.serial(nodeId, async () => {
      this.db.transaction(() => {
        // 后续 request 也会串行化。按顺序应用每个已接受 transition。
        this.db.prepare("UPDATE seat_delivery_guards SET effective = ? WHERE node_id = ?").run(Number(enabled), nodeId);
        this.db.prepare("UPDATE seat_delivery_guard_changes SET effective_at = ? WHERE id = ?")
          .run(new Date().toISOString(), change);
      })();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([activation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.preference(nodeId);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** fn 必须包含 lifecycle preflight、effect 与最后一次 write。retention callback 在同一 lease 下、
   * 任何 pane capture/paste/submit 分支前执行。 */
  async operation<T>(name: string, fn: () => Promise<T>, held?: (target: GuardTarget) => Promise<T>): Promise<T> {
    const bound = this.target(name);
    const inherited = this.scope.getStore()?.get(bound.nodeId);
    if (inherited?.active && inherited.target.nodeId === bound.nodeId) {
      this.assertCurrent(name, inherited);
      return fn();
    }
    return this.serial(bound.nodeId, async () => {
      const current = this.target(name);
      if (!this.same(bound, current)) throw new DeliveryGuardError("guard_target_changed", "等待期间 input target 已变化；未写入任何 input。");
      const pref = this.preference(bound.nodeId);
      if (pref.effective || pref.desired) {
        if (held) return held(bound);
        throw new DeliveryGuardError("typing_guard_enabled", "此 seat 的自动 input 已暂停。请在本次写入操作前显式禁用其 typing guard。");
      }
      const lease: Lease = { target: bound, active: true, origin: "automatic" };
      try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
      finally { lease.active = false; }
    });
  }

  ownsLifecycle(nodeId: string): boolean {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) return false;
    this.assertCurrent(nodeId, lease);
    return true;
  }

  /** multi-seat restore 在任何工作组修改前按稳定顺序获取 lease。嵌套 per-seat launch 加入这些
   * lease，不得重新获取。 */
  async lifecycle<T>(nodeIds: string[], fn: () => Promise<T>): Promise<T> {
    const ids = [...new Set(nodeIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const id = ids[index]; if (!id) return fn();
      if (this.ownsLifecycle(id)) return acquire(index + 1);
      return this.operation(id, async () => {
        const lease = this.scope.getStore()!.get(id)!;
        lease.lifecycle = true;
        return acquire(index + 1);
      });
    };
    return acquire(0);
  }

  /** 仅在其 lease 下发生有意 lifecycle binding 变更后调用。普通 send 无法采用 replacement
   * occupant 或复用 pane。 */
  rebindLifecycle(nodeId: string): void {
    const lease = this.scope.getStore()?.get(nodeId);
    if (!lease?.active || !lease.lifecycle) throw new DeliveryGuardError("guard_lease_required", "Binding 变更需要完整 lifecycle lease。");
    lease.target = this.target(nodeId);
  }

  private assertCurrent(name: string, lease: Lease): void {
    if (!lease.active || !this.same(lease.target, this.target(name))) {
      throw new DeliveryGuardError("guard_target_changed", "Input target/occupant 已变化；未写入任何 input。");
    }
  }

  /** 同步 final-effect check：从这里到发出 write 之间没有 await。 */
  checkInput(name: string): void {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (!lease) throw new DeliveryGuardError("guard_lease_required", "Input 需要 active operation lease。");
    this.assertCurrent(name, lease);
  }

  /** reconciliation 是同步 DB transaction，而非嵌套 input operation。直接拒绝，不等待可能
   * 正在等待此调用的 sender。pending activation 与显式 human input 保护同一个 occupant boundary。 */
  reconcileBinding<T>(expected: GuardTarget, commit: () => T): T {
    if (!this.same(expected, this.target(expected.nodeId))) {
      throw new DeliveryGuardError("guard_target_changed", "observation 期间 reconciliation target 已变化；请使用当前 identity 重试。");
    }
    if (this.tails.has(expected.nodeId) || [...this.humanLeases].some(l => l.active && l.target.nodeId === expected.nodeId)) {
      throw new DeliveryGuardError("guard_operation_in_progress", "Seat operation 正在进行；reconciliation 未更改 custody。请在操作结束后重试。");
    }
    const pref = this.preference(expected.nodeId);
    if (pref.desired || pref.effective) {
      throw new DeliveryGuardError("typing_guard_enabled", "typing protection 启用期间，reconciliation 无法替换 occupant。");
    }
    return commit();
  }

  async input<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const lease = this.scope.getStore()?.get(target.nodeId);
    if (lease?.active) { this.assertCurrent(name, lease); return fn(); }
    return this.operation(name, fn);
  }

  /** 仅供内部 broker 路径使用；绝不是 send HTTP route 接受的 option。 */
  async humanInput<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const target = this.target(name);
    const lease: Lease = { target, active: true, origin: "human" };
    this.humanLeases.add(lease);
    try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [lease.target.nodeId, lease]]), fn); }
    finally { lease.active = false; this.humanLeases.delete(lease); }
  }
}

/** 当前 binding，绝非对最新历史 session name 的猜测。未绑定 seat 按 node/canonical address
 * 解析 preference 与 lifecycle preflight。 */
export function resolveGuardTarget(db: Database.Database, name: string): GuardTarget | null {
  const rows = db.prepare(`SELECT n.id AS nodeId,
      coalesce(b.tmux_session, replace(n.logical_id,'.','-') || '@' || r.name) AS session,
      b.tmux_pane AS pane,
      (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id=n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant
    FROM nodes n JOIN rigs r ON r.id=n.rig_id LEFT JOIN bindings b ON b.node_id=n.id
    WHERE n.id=? OR b.tmux_session=? OR b.tmux_pane=? OR n.logical_id=?
      OR (b.tmux_session IS NULL AND replace(n.logical_id,'.','-') || '@' || r.name=?)`)
    .all(name, name, name, name, name) as GuardTarget[];
  return rows.length === 1 ? rows[0]! : null;
}
