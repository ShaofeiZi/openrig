import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";
import { validateHostRegistry } from "./host-registry.js";

/** 读取启动时铸造的身份，不需要本地后台服务，也不重新铸造替代值。 */
export function readLocalOrigin(): string | undefined {
  let db: Database.Database | undefined;
  try {
    const configured = new ConfigStore().resolveWithSource("db.path");
    let dbPath = configured.value as string;
    // 显式配置的 DB 优先。否则保留上次启动时的 --db 选择。
    if (configured.source === "default") {
      try {
        const state = JSON.parse(readFileSync(join(getOpenRigHome(), "daemon.json"), "utf8"));
        if (typeof state.db === "string" && state.db.length > 0) dbPath = state.db;
      } catch { /* 无启动记录：使用配置的默认值，绝不搜索其他 home。 */ }
    }
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
    const row = db.prepare("SELECT host_id FROM self_host_identity WHERE singleton = 1").get() as { host_id?: unknown } | undefined;
    const id = row?.host_id;
    if (typeof id !== "string" || id === "localhost") return undefined;
    const valid = validateHostRegistry({ hosts: [{ id, transport: "ssh", target: "identity-validation" }] }, "<local-origin>");
    return valid.ok ? id : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
