import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { isCodex013xOrLater } from "../src/adapters/codex-runtime-adapter.js";

const require = createRequire(import.meta.url);

describe("resume provenance + 优先级", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
    sessionRegistry.registerSession(node.id, "dev-worker@test-rig");
  });

  afterEach(() => db.close());

  function getSessionId(): string {
    const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
    return row.id;
  }

  function getProvenance(): string | null {
    const row = db.prepare("SELECT resume_provenance FROM sessions LIMIT 1").get() as { resume_provenance: string | null };
    return row.resume_provenance;
  }

  function getToken(): string | null {
    const row = db.prepare("SELECT resume_token FROM sessions LIMIT 1").get() as { resume_token: string | null };
    return row.resume_token;
  }

  it("hook 写入设置 provenance=hook", () => {
    sessionRegistry.updateResumeToken(getSessionId(), "codex_id", "thread-123", "hook");
    expect(getProvenance()).toBe("hook");
    expect(getToken()).toBe("thread-123");
  });

  it("没有现有 token 时，scrape 写入设置 provenance=scrape", () => {
    sessionRegistry.updateResumeToken(getSessionId(), "codex_id", "thread-456", "scrape");
    expect(getProvenance()).toBe("scrape");
    expect(getToken()).toBe("thread-456");
  });

  it("scrape 写入不覆盖 hook-provenance token", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "scrape-thread", "scrape");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });

  it("hook 写入可以覆盖 scrape-provenance token", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "scrape-thread", "scrape");
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });

  it("重复应用相同 hook token 时幂等", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "thread-123", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "thread-123", "hook");
    expect(getToken()).toBe("thread-123");
    expect(getProvenance()).toBe("hook");
  });

  it("startup-orchestrator scrape 不覆盖 hook", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    sessionRegistry.updateResumeToken(id, "codex_id", "launch-scrape-thread", "scrape");
    expect(getToken()).toBe("hook-thread");
    expect(getProvenance()).toBe("hook");
  });
});

describe("isCodex013xOrLater", () => {
  it("0.139.0 属于 013x+", () => expect(isCodex013xOrLater("0.139.0")).toBe(true));
  it("0.130.0 属于 013x+", () => expect(isCodex013xOrLater("0.130.0")).toBe(true));
  it("0.120.0 不属于 013x+", () => expect(isCodex013xOrLater("0.120.0")).toBe(false));
  it("0.125.0 不属于 013x+", () => expect(isCodex013xOrLater("0.125.0")).toBe(false));
  it("1.0.0 属于 013x+", () => expect(isCodex013xOrLater("1.0.0")).toBe(true));
  it("空字符串不属于 013x+", () => expect(isCodex013xOrLater("")).toBe(false));
});

describe("activity-relay 会话 identity", () => {
  it("buildSessionIdentityPayload 从 env 读取 OpenRig identity，从 stdin 读取 session_id", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const env = { OPENRIG_SESSION_NAME: "dev-worker@test-rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "codex" };
    const payload = buildSessionIdentityPayload(
      { hookEvent: "SessionStart", session_id: "thread-abc-123" },
      env,
    );
    expect(payload).not.toBeNull();
    expect(payload.eventFamily).toBe("session_identity");
    expect(payload.sessionId).toBe("thread-abc-123");
    expect(payload.sessionName).toBe("dev-worker@test-rig");
    expect(payload.runtime).toBe("codex");
  });

  it("buildSessionIdentityPayload 对非 SessionStart 返回 null", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const env = { OPENRIG_SESSION_NAME: "dev-worker@test-rig", OPENRIG_RUNTIME: "codex" };
    const payload = buildSessionIdentityPayload({ hookEvent: "UserPromptSubmit", session_id: "thread-abc-123" }, env);
    expect(payload).toBeNull();
  });

  it("缺少 session_id 时 buildSessionIdentityPayload 返回 null", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const env = { OPENRIG_SESSION_NAME: "dev-worker@test-rig", OPENRIG_RUNTIME: "codex" };
    const payload = buildSessionIdentityPayload({ hookEvent: "SessionStart" }, env);
    expect(payload).toBeNull();
  });

  it("provider payload 有 identity 但 env 没有时返回 null", () => {
    const { buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const payload = buildSessionIdentityPayload(
      { hookEvent: "SessionStart", session_id: "thread-123", sessionName: "foo", runtime: "codex" },
      {},
    );
    expect(payload).toBeNull();
  });
});

describe("clearResumeToken 清除 provenance", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
    sessionRegistry.registerSession(node.id, "dev-worker@test-rig");
  });

  afterEach(() => db.close());

  function getSessionId(): string {
    return (db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string }).id;
  }

  it("clearResumeToken 清除 provenance，使 scrape 可随后写入", () => {
    const id = getSessionId();
    sessionRegistry.updateResumeToken(id, "codex_id", "hook-thread", "hook");
    sessionRegistry.clearResumeToken(id);

    const row = db.prepare("SELECT resume_provenance FROM sessions WHERE id = ?").get(id) as { resume_provenance: string | null };
    expect(row.resume_provenance).toBeNull();

    sessionRegistry.updateResumeToken(id, "codex_id", "scrape-thread", "scrape");
    const after = db.prepare("SELECT resume_token, resume_provenance FROM sessions WHERE id = ?").get(id) as { resume_token: string; resume_provenance: string };
    expect(after.resume_token).toBe("scrape-thread");
    expect(after.resume_provenance).toBe("scrape");
  });
});

// F3 version-aware 测试已移至 codex-hooks-feature-flag.test.ts，并使用真实 CodexRuntimeAdapter。
