import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const allMigrations = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema,
  bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema,
];

function freshDb() {
  const db = createDb();
  migrate(db, allMigrations);
  return db;
}

function getColumnNames(db: ReturnType<typeof createDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableExists(db: ReturnType<typeof createDb>, table: string): boolean {
  const row = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(table) as { cnt: number };
  return row.cnt > 0;
}

describe("AgentSpec 重启 schema 迁移（014）", () => {
  // T1：创建包含预期列的 pods 表
  it("创建包含预期列的 pods 表", () => {
    const db = freshDb();
    const cols = getColumnNames(db, "pods");
    expect(cols).toEqual(expect.arrayContaining(["id", "rig_id", "label", "summary", "continuity_policy_json", "created_at"]));
  });

  // T2：带复合主键的 continuity_state 表
  it("创建包含预期列与复合主键的 continuity_state 表", () => {
    const db = freshDb();
    const cols = getColumnNames(db, "continuity_state");
    expect(cols).toEqual(expect.arrayContaining(["pod_id", "node_id", "status", "artifacts_json", "last_sync_at", "updated_at"]));

    // 插入装备、工作组、节点及两条工作组/节点组合不同的 continuity_state 行，验证复合主键
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES ('p1', 'r1', 'Dev')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'impl')").run();
    db.prepare("INSERT INTO continuity_state (pod_id, node_id) VALUES ('p1', 'n1')").run();

    // 重复项应失败
    expect(() => {
      db.prepare("INSERT INTO continuity_state (pod_id, node_id) VALUES ('p1', 'n1')").run();
    }).toThrow();
  });

  // T3：nodes 表增加全部 7 个重启字段
  it("nodes 表包含 7 个新增重启字段", () => {
    const db = freshDb();
    const cols = getColumnNames(db, "nodes");
    for (const col of ["pod_id", "agent_ref", "profile", "label", "resolved_spec_name", "resolved_spec_version", "resolved_spec_hash"]) {
      expect(cols).toContain(col);
    }
  });

  // T4：sessions 表增加启动字段
  it("sessions 表包含 startup_status 与 startup_completed_at", () => {
    const db = freshDb();
    const cols = getColumnNames(db, "sessions");
    expect(cols).toContain("startup_status");
    expect(cols).toContain("startup_completed_at");
  });

  // T5：checkpoints 增加 pod_id、continuity_source、continuity_artifacts_json
  it("checkpoints 表包含工作组/连续性字段", () => {
    const db = freshDb();
    const cols = getColumnNames(db, "checkpoints");
    expect(cols).toContain("pod_id");
    expect(cols).toContain("continuity_source");
    expect(cols).toContain("continuity_artifacts_json");
  });

  // T6：迁移幂等（应用两次）
  it("迁移在全新数据库上幂等", () => {
    const db = createDb();
    migrate(db, allMigrations);
    // 第二次应用应不执行操作（已应用）
    expect(() => migrate(db, allMigrations)).not.toThrow();
  });

  // T7：完整链路的外键插入成功
  it("工作组、带 pod_id 的节点、continuity_state 及带 pod_id 的 checkpoint 外键插入成功", () => {
    const db = freshDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare("INSERT INTO pods (id, rig_id, label, summary) VALUES ('p1', 'r1', 'Dev', 'dev pod')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, pod_id, agent_ref, profile) VALUES ('n1', 'r1', 'impl', 'p1', 'local:agents/impl', 'tdd')").run();
    db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES ('p1', 'n1', 'healthy')").run();
    db.prepare("INSERT INTO checkpoints (id, node_id, summary, pod_id, continuity_source, continuity_artifacts_json) VALUES ('c1', 'n1', 'test checkpoint', 'p1', 'pre_shutdown', '{\"session_log\": \"/tmp/log.md\"}')").run();

    const pod = db.prepare("SELECT * FROM pods WHERE id = 'p1'").get() as Record<string, unknown>;
    expect(pod.label).toBe("Dev");

    const node = db.prepare("SELECT * FROM nodes WHERE id = 'n1'").get() as Record<string, unknown>;
    expect(node.pod_id).toBe("p1");
    expect(node.agent_ref).toBe("local:agents/impl");

    const cs = db.prepare("SELECT * FROM continuity_state WHERE pod_id = 'p1'").get() as Record<string, unknown>;
    expect(cs.status).toBe("healthy");

    const cp = db.prepare("SELECT * FROM checkpoints WHERE id = 'c1'").get() as Record<string, unknown>;
    expect(cp.pod_id).toBe("p1");
    expect(cp.continuity_source).toBe("pre_shutdown");
  });

  // T8：级联/SET NULL 行为
  it("删除装备会级联到工作组；删除工作组会将 node.pod_id 设为 NULL", () => {
    const db = freshDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES ('p1', 'r1', 'Dev')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, pod_id) VALUES ('n1', 'r1', 'impl', 'p1')").run();
    db.prepare("INSERT INTO checkpoints (id, node_id, summary, pod_id) VALUES ('c1', 'n1', 'cp', 'p1')").run();

    // 删除工作组 -> node.pod_id 与 checkpoint.pod_id 变为 NULL
    db.prepare("DELETE FROM pods WHERE id = 'p1'").run();
    const node = db.prepare("SELECT pod_id FROM nodes WHERE id = 'n1'").get() as { pod_id: string | null };
    expect(node.pod_id).toBeNull();
    const cp = db.prepare("SELECT pod_id FROM checkpoints WHERE id = 'c1'").get() as { pod_id: string | null };
    expect(cp.pod_id).toBeNull();

    // 删除装备 -> 级联删除节点（进而级联删除 checkpoints）
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES ('p2', 'r1', 'Arch')").run();
    db.prepare("DELETE FROM rigs WHERE id = 'r1'").run();
    const pods = db.prepare("SELECT count(*) as cnt FROM pods WHERE rig_id = 'r1'").get() as { cnt: number };
    expect(pods.cnt).toBe(0);
  });

  // T9：解析后规范字段往返
  it("解析后规范字段可经数据库往返", () => {
    const db = freshDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
      VALUES ('n1', 'r1', 'impl', 'implementer', '0.2', 'sha256:abc123')`).run();

    const row = db.prepare("SELECT resolved_spec_name, resolved_spec_version, resolved_spec_hash FROM nodes WHERE id = 'n1'").get() as Record<string, unknown>;
    expect(row.resolved_spec_name).toBe("implementer");
    expect(row.resolved_spec_version).toBe("0.2");
    expect(row.resolved_spec_hash).toBe("sha256:abc123");
  });

  // T10：不存在 session_artifacts 表
  it("迁移后不存在 session_artifacts 表", () => {
    const db = freshDb();
    expect(tableExists(db, "session_artifacts")).toBe(false);
  });

  // T11：已有数据的数据库：所有现有会话回填 startup_status=ready，新会话为 pending
  it("已有数据的数据库：现有会话回填为 ready，新会话默认为 pending", () => {
    const db = createDb();
    // 应用重启前迁移
    const preMigrations = allMigrations.slice(0, -1); // all except 014
    migrate(db, preMigrations);

    // 创建装备、节点及不同状态的会话
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'impl')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-running', 'n1', 'r01-run', 'running')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-idle', 'n1', 'r01-idle', 'idle')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-unknown', 'n1', 'r01-unk', 'unknown')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-exited', 'n1', 'r01-exit', 'exited')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-detach', 'n1', 'r01-det', 'detached')").run();

    // 现在应用 014
    migrate(db, [agentspecRebootSchema]);

    // 所有现有会话都应为 ready
    const rows = db.prepare("SELECT id, startup_status FROM sessions ORDER BY id").all() as { id: string; startup_status: string }[];
    for (const row of rows) {
      expect(row.startup_status).toBe("ready");
    }

    // 迁移后插入的新会话应默认为 pending
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-new', 'n1', 'r01-new', 'running')").run();
    const newRow = db.prepare("SELECT startup_status FROM sessions WHERE id = 's-new'").get() as { startup_status: string };
    expect(newRow.startup_status).toBe("pending");
  });

  // T11b：已认领会话通过 registerClaimedSession() 获得 startup_status=ready
  it("registerClaimedSession 设置 startup_status=ready", () => {
    const db = freshDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'test')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'impl')").run();

    const registry = new SessionRegistry(db);
    const session = registry.registerClaimedSession("n1", "organic-session");

    expect(session.startupStatus).toBe("ready");
    expect(session.status).toBe("running");
    expect(session.origin).toBe("claimed");
  });
});
