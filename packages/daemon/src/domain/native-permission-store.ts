import type Database from "better-sqlite3";
import type { NodeBinding } from "./runtime-adapter.js";
import { permissionBindingOverride, type NativePermissionSelection } from "./native-permission-selection.js";

export interface StoredNativePermissionSelection extends NativePermissionSelection {
  actor: string;
  reason: string;
  updatedAt: string;
}

/** 期望设置归稳定节点所有；不修改原生历史记录和当前进程。 */
export class NativePermissionStore {
  constructor(private readonly db: Database.Database) {}

  read(nodeId: string): StoredNativePermissionSelection | null {
    const row = this.db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
      runtime: string; mode: string; actor: string; reason: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    if ((row.runtime !== "codex" && row.runtime !== "claude-code") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.mode)
      || (row.runtime === "codex" && row.mode !== "floor" && row.mode !== "full_bypass")) {
      throw new Error("持久化的原生权限选择无效，已拒绝启动。");
    }
    return { runtime: row.runtime, mode: row.mode, actor: row.actor, reason: row.reason, updatedAt: row.updated_at };
  }

  write(nodeId: string, selection: NativePermissionSelection | null, actor: string, reason: string): void {
    if (!selection) {
      this.db.prepare("DELETE FROM node_permission_selections WHERE node_id = ?").run(nodeId);
      return;
    }
    this.db.prepare(`INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET runtime=excluded.runtime, mode=excluded.mode,
        actor=excluded.actor, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(nodeId, selection.runtime, selection.mode, actor, reason);
  }

  apply(binding: NodeBinding, runtime: string): NodeBinding {
    const selection = this.read(binding.nodeId);
    if (selection && selection.runtime !== runtime) throw new Error("权限选择后席位运行时已改变；请重新显式选择或继承设置。");
    return { ...binding, ...permissionBindingOverride(selection) };
  }
}
