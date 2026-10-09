// Slice 09——由后台服务持久化的类型化原语（SQLite 后端）。
//
// 遵循 workspace-primitive 先例：使用结构化表和保存 10 字段记录的 JSON 列，
// 由 validator 在写入时保证完整性。不建立并行/分叉 store（HG-5）。
//
// store 暴露：
//   - setBinding(scope, qualifier, mode, record)  → upsert 一行
//                                                    （mode 是 binding 级
//                                                    Component-2 identity；
//                                                    record 为冻结后的 10 字段
//                                                    Component-3 设置）
//   - getBinding(scope, qualifier)                → 读取一行
//   - listBindings()                              → 所有行（供 show 使用）
//   - resolveEffective(readContext)               → 最具体的 binding
//   - deleteBinding(scope, qualifier)             → 取消设置
//
// 更新权限仅属于操作者：setBinding 硬编码 `set_by = 'operator'`。HTTP 路由与 CLI 是唯一写入
// 表面；智能体代码路径只读不写（HG-4）。
//
// 此处保持 HG-SAFE：本 store 绝不写权限 allowlist、运行时配置、认证、tmux 或生命周期状态。
// 它只写一张表（operator_context_mode_bindings）并读取 JSON。未来贡献者无法通过本服务扩大
// 权限，因为其表面仅限绑定表。

import type Database from "better-sqlite3";
import {
  type EffectiveOperatorContextMode,
  type OperatorContextMode,
  type OperatorContextModeBinding,
  type OperatorContextModeRecord,
  type OperatorContextReadContext,
  type OperatorContextScope,
  SCOPE_SPECIFICITY,
  missionModeQualifier,
} from "./rig-mode-types.js";
import { validateModeName, validateRecord } from "./rig-mode-validator.js";

interface BindingRow {
  id: string;
  scope: OperatorContextScope;
  qualifier: string | null;
  mode: OperatorContextMode;
  record_json: string;
  set_at: string;
  set_by: string;
}

function rowToBinding(row: BindingRow): OperatorContextModeBinding {
  return {
    id: row.id,
    mode: row.mode,
    record: JSON.parse(row.record_json) as OperatorContextModeRecord,
    qualifier: row.qualifier,
    setAt: row.set_at,
    setBy: "operator",
  };
}

function bindingId(scope: OperatorContextScope, qualifier: string | null): string {
  return `${scope}:${qualifier ?? "host"}`;
}

export interface SetBindingResult {
  ok: true;
  binding: OperatorContextModeBinding;
}

export interface SetBindingError {
  ok: false;
  errors: string[];
}

export interface RigModeStoreOpts {
  /** 测试可覆盖时钟；默认使用 new Date()。 */
  now?: () => Date;
}

export class RigModeStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(db: Database.Database, opts?: RigModeStoreOpts) {
    this.db = db;
    this.now = opts?.now ?? (() => new Date());
  }

  /**
   * 仅操作者可设置。先校验候选记录及 scope/qualifier 形状，再执行 upsert；
   * 成功时返回类型化 binding。
   *
   * scope == 'global_host' 要求 qualifier === null；
   * scope != 'global_host' 要求 qualifier 是非空字符串。
   * 两者都是操作者/主机不变量：路由负责校验，store 在不一致时拒绝。
   */
  setBinding(
    scope: OperatorContextScope,
    qualifier: string | null,
    mode: unknown,
    candidateRecord: unknown,
  ): SetBindingResult | SetBindingError {
    const errors: string[] = [];
    if (scope === "global_host" && qualifier !== null) {
      errors.push(
        `全局主机 binding 不能携带 qualifier（收到 ${JSON.stringify(qualifier)}）。global_host scope 请传入 null。`,
      );
    }
    if (scope !== "global_host" && (typeof qualifier !== "string" || qualifier.length === 0)) {
      errors.push(
        `${scope} binding 要求提供 qualifier（rigId / workstreamId / qitemId）。收到 ${JSON.stringify(qualifier)}。`,
      );
    }
    const modeCheck = validateModeName(mode);
    if (!modeCheck.ok) errors.push(modeCheck.error);
    const validation = validateRecord(candidateRecord);
    if (!validation.ok) errors.push(...validation.errors);
    if (errors.length > 0 || !modeCheck.ok || !validation.ok) {
      return { ok: false, errors };
    }

    const record = validation.record;
    if (record.scope !== scope) {
      return {
        ok: false,
        errors: [
          `记录 scope 不匹配：binding scope 为“${scope}”，但 record.scope 为“${record.scope}”。记录的 scope 字段必须与 binding scope 一致。`,
        ],
      };
    }

    const id = bindingId(scope, qualifier);
    const setAt = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO operator_context_mode_bindings (id, scope, qualifier, mode, record_json, set_at, set_by)
      VALUES (?, ?, ?, ?, ?, ?, 'operator')
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        record_json = excluded.record_json,
        set_at = excluded.set_at
    `).run(id, scope, qualifier, modeCheck.mode, JSON.stringify(record), setAt);

    return {
      ok: true,
      binding: {
        id,
        mode: modeCheck.mode,
        record,
        qualifier,
        setAt,
        setBy: "operator",
      },
    };
  }

  getBinding(
    scope: OperatorContextScope,
    qualifier: string | null,
  ): OperatorContextModeBinding | null {
    const row = this.db.prepare(`
      SELECT id, scope, qualifier, mode, record_json, set_at, set_by
      FROM operator_context_mode_bindings
      WHERE id = ?
    `).get(bindingId(scope, qualifier)) as BindingRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  listBindings(): OperatorContextModeBinding[] {
    const rows = this.db.prepare(`
      SELECT id, scope, qualifier, mode, record_json, set_at, set_by
      FROM operator_context_mode_bindings
      ORDER BY scope, qualifier NULLS FIRST, id
    `).all() as BindingRow[];
    return rows.map(rowToBinding);
  }

  deleteBinding(scope: OperatorContextScope, qualifier: string | null): boolean {
    const info = this.db.prepare(`
      DELETE FROM operator_context_mode_bindings WHERE id = ?
    `).run(bindingId(scope, qualifier));
    return info.changes > 0;
  }

  /**
   * 为读取上下文解析最具体的适用 binding。没有匹配项时返回 null；按约定 §Q6，调用方必须
   * 将 null 视为 `unknown_posture`，不得默认为 `desk`。
   *
   * 具体度顺序（qitem > workstream > rig > global_host）定义于
   * rig-mode-types.SCOPE_SPECIFICITY。Resolver 在每个 scope 中选择 qualifier 与读取上下文匹配的
   * binding；若有多个匹配项，最具体的 scope 胜出。
   */
  resolveEffective(ctx: OperatorContextReadContext, modes?: readonly OperatorContextMode[]): EffectiveOperatorContextMode | null {
    const candidates: OperatorContextModeBinding[] = [];
    if (ctx.qitemId) {
      const b = this.getBinding("qitem", ctx.qitemId);
      if (b) candidates.push(b);
    }
    if (ctx.workstreamId) {
      const b = this.getBinding("workstream", ctx.workstreamId);
      if (b) candidates.push(b);
    }
    if (ctx.projectId && ctx.missionId) {
      const b = this.getBinding("mission", missionModeQualifier(ctx.projectId, ctx.missionId));
      if (b) candidates.push(b);
    }
    if (ctx.projectId) {
      const b = this.getBinding("project", ctx.projectId);
      if (b) candidates.push(b);
    }
    if (ctx.rigId) {
      const b = this.getBinding("rig", ctx.rigId);
      if (b) candidates.push(b);
    }
    const host = this.getBinding("global_host", null);
    if (host) candidates.push(host);

    if (candidates.length === 0) return null;
    if (modes && candidates.some((b) => !validateModeName(b.mode).ok || !validateRecord(b.record).ok
      || b.id !== bindingId(b.record.scope, b.qualifier))) {
      throw new Error("已存储的 mode binding 无效");
    }

    candidates.sort(
      (a, b) => SCOPE_SPECIFICITY[b.record.scope] - SCOPE_SPECIFICITY[a.record.scope],
    );
    const winner = candidates.find((b) => !modes || modes.includes(b.mode));
    if (!winner) return null;
    return {
      binding: winner,
      resolvedScope: winner.record.scope,
    };
  }
}
