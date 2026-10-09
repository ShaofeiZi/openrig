/**
 * Seed 脚本——创建包含节点与边的示例 rig，用于视觉 QA。
 * 用法：npx tsx packages/daemon/src/seed.ts [dbPath]
 */
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";

const dbPath = process.argv[2] ?? "openrig.sqlite";

console.log(`正在填充数据库：${dbPath}`);

const db = createDb(dbPath);
migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema]);

const repo = new RigRepository(db);

// 创建示例 rig。
const rig = repo.createRig("r99");
console.log(`已创建 rig：${rig.id}（${rig.name}）`);

// 添加节点——使用 r99-demo-* 名称，避免与真实 tmux session 冲突。
const orch = repo.addNode(rig.id, "demo1-lead", { role: "orchestrator", runtime: "claude-code", model: "opus" });
const impl = repo.addNode(rig.id, "demo1-impl", { role: "worker", runtime: "claude-code", model: "opus" });
const qa = repo.addNode(rig.id, "demo1-qa", { role: "qa", runtime: "codex", model: "gpt-5.4" });
const reviewer = repo.addNode(rig.id, "demo1-rev", { role: "reviewer", runtime: "claude-code", model: "opus" });

console.log(`已创建节点：${orch.logicalId}、${impl.logicalId}、${qa.logicalId}、${reviewer.logicalId}`);

// 添加边。
repo.addEdge(rig.id, orch.id, impl.id, "delegates_to");
repo.addEdge(rig.id, orch.id, qa.id, "delegates_to");
repo.addEdge(rig.id, impl.id, qa.id, "can_observe");
repo.addEdge(rig.id, orch.id, reviewer.id, "delegates_to");

console.log("已创建边：orch->impl、orch->qa、impl->qa、orch->reviewer");

// 为 orchestrator 添加带 cmuxSurface 的绑定，用于焦点点击跳转 QA。
const sessionRegistry = new SessionRegistry(db);
sessionRegistry.updateBinding(orch.id, {
  tmuxSession: "r99-demo1-lead",
  cmuxSurface: "surface-orch-1",
});
console.log("已为 orch1-lead 添加 cmuxSurface 绑定（surface-orch-1）");

db.close();
console.log("完成。可使用以下命令启动后台服务：OPENRIG_DB=" + dbPath + " npx tsx packages/daemon/src/index.ts");
