// OPR.0.5.6.23——silent-erasure remint（已锁定 spec；desk territory ruling 22:22Z
// 将 member-b 扩展到 routes/agent-images.ts fork memberFragment seam）。
// 清点见本文件旁的 s23-session-source-leg-census.md。
//
// Member (a)：codec serialize 分支丢弃 session_source.ref.version——可在 expand（S03 后）中
// 保留的 pin 会在 spec 往返时消失（WAVE 1 R2 HOLD shape）。同一 seam 还发现第三项：parse
// 携带 compaction_strategy，serialize 从不发出。Member (b)：fork-ingress memberFragment 丢弃
// node 携带的 model/role/restore_policy/label——fork 后的 seat 会静默丢失 model pin
//（0.4.6.PI1 failure class）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { RigSpec, RigSpecPodMember, RigServicesSpec, SessionSourceSpec } from "../src/domain/types.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { PodRigInstantiator } from "../src/domain/pod-rigspec-instantiator.js";

function rigWith(member: Partial<RigSpecPodMember> & { id: string }): RigSpec {
  return {
    version: "0.2",
    name: "s23-rig",
    summary: "s23",
    cultureFile: "culture.md",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        agentRef: "local:agents/impl",
        profile: "tdd",
        runtime: "claude-code",
        cwd: ".",
        ...member,
      } as RigSpecPodMember],
      edges: [],
    }],
    edges: [],
  };
}

function roundTripMember(member: Partial<RigSpecPodMember> & { id: string }): { yaml: string; member: RigSpecPodMember } {
  const yaml = RigSpecCodec.serialize(rigWith(member));
  const parsed = RigSpecCodec.parse(yaml);
  const validation = RigSpecSchema.validate(parsed);
  expect(validation.errors, `round-trip must stay schema-valid: ${validation.errors?.join("; ")}`).toEqual([]);
  const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>);
  return { yaml, member: normalized.pods[0]!.members[0]! };
}

describe("OPR.0.5.6.23 member (a)——codec 往返保留每个可选 sessionSource 字段", () => {
  it("RT-VERSION：session_source.ref.version 经 serialize -> parse -> normalize 后存留，YAML 本身也携带该 key", () => {
    const input: SessionSourceSpec = { mode: "agent_image", ref: { kind: "image_name", value: "starter", version: "1.2.3" } };
    const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
    // 基线 RED：serialize 只发出 kind/value——重新 parse 后 version 为 undefined
    expect(member.sessionSource).toEqual(input);
    expect(yaml).toContain("version: 1.2.3"); // absence in every encoding: the YAML carries it
  });

  it("KEYSET-PIN：对携带全部可选字段的每个 union arm，serialized ref key-set 等于 input ref key-set", () => {
    const arms: SessionSourceSpec[] = [
      { mode: "fork", ref: { kind: "native_id", value: "tok-1" } },
      { mode: "rebuild", ref: { kind: "artifact_set", value: ["a.md", "b.md"] } },
      { mode: "agent_image", ref: { kind: "image_name", value: "img", version: "7" } },
    ];
    for (const input of arms) {
      const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
      expect(member.sessionSource, `arm ${input.mode}`).toEqual(input);
      const parsed = RigSpecCodec.parse(yaml) as { pods: Array<{ members: Array<Record<string, unknown>> }> };
      const rawRef = (parsed.pods[0]!.members[0]!["session_source"] as { ref: Record<string, unknown> }).ref;
      expect(Object.keys(rawRef).sort(), `arm ${input.mode}: no ref key may silently vanish`)
        .toEqual(Object.keys(input.ref).sort());
    }
  });

  it("RT-COMPACTION（同一 seam 发现的第三项）：member compaction_strategy 经往返后存留", () => {
    // canonical vocabulary（agent-manifest.ts VALID_COMPACTION_STRATEGIES）；deprecated alias
    // 会在 parse 时 normalize，从而掩盖此 pin。
    const { yaml, member } = roundTripMember({ id: "impl", compactionStrategy: "managed-compaction" });
    // 基线 RED：schema parse 携带它（:1058），serialize 分支从不发出
    expect(member.compactionStrategy).toBe("managed-compaction");
    expect(yaml).toContain("compaction_strategy: managed-compaction");
  });
});

describe("OPR.0.5.6.23 member (c)——codec 发出可选顶层 services family（desk ruling，transition 45061）", () => {
  // 与 member (a) 同类：parse 接受并 normalize services（rigspec-schema :109/:197），serialize
  // 却省略它——export-YAML -> re-import 会静默丢弃整个 block。fixture 填充每个可选 services
  // field；此 pin 明确要求保留 key/value，而不只是存在即可。
  const servicesInput: RigServicesSpec = {
    kind: "compose",
    composeFile: "services/compose.yaml",
    projectName: "s23svc",
    profiles: ["dev", "ci"],
    downPolicy: "down_and_volumes",
    waitFor: [
      { service: "db", condition: "healthy" },
      { url: "http://localhost:8080/healthz" },
      { tcp: "localhost:5432" },
    ],
    surfaces: {
      urls: [{ name: "app", url: "http://localhost:3000" }],
      commands: [{ name: "psql", command: "psql -h localhost -p 5432" }],
    },
    checkpoints: [
      { id: "db-dump", exportCommand: "pg_dump app > dump.sql", importCommand: "psql app < dump.sql" },
      { id: "export-only", exportCommand: "tar cf state.tar state/" },
    ],
  };

  it("RT-SERVICES：非平凡 services family 经 serialize -> YAML -> parse -> normalize 后所有 key/value 完整保留", () => {
    const spec: RigSpec = { ...rigWith({ id: "impl" }), services: servicesInput };
    const yaml = RigSpecCodec.serialize(spec);
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.errors, `round-trip must stay schema-valid: ${validation.errors?.join("; ")}`).toEqual([]);
    // 基线 RED：serialize 不读取 spec.services——YAML 中没有 services key
    const rawServices = parsed["services"] as Record<string, unknown> | undefined;
    expect(rawServices, "the serialized YAML must carry the services block").toBeDefined();
    expect(Object.keys(rawServices ?? {}).sort(), "no services key may silently vanish").toEqual(
      ["checkpoints", "compose_file", "down_policy", "kind", "profiles", "project_name", "surfaces", "wait_for"]
    );
    const normalized = RigSpecSchema.normalize(parsed);
    // value-level pin：要求 deep-equal，而非仅存在——整个 family 可往返
    expect(normalized.services).toEqual(servicesInput);
  });
});

describe("OPR.0.5.6.23 member (b)——fork-ingress memberFragment 转发每个 node 携带的可选字段", () => {
  let tmp: string;
  let specRoot: string;
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s23-fork-"));
    specRoot = join(tmp, "specs");
    mkdirSync(specRoot, { recursive: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("FORK-FRAGMENT：source seat 的 model、role、restore_policy 与 label 随 fork 传递（model pin 属于 0.4.6.PI1 类）", async () => {
    const rig = rigRepo.createRig("src-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/work",
      agentRef: "local:agents/impl",
      profile: "default",
      model: "claude-opus-5",
      role: "worker",
      restorePolicy: "resume_if_possible",
      label: "Implementer",
    });
    const sessionId = ulid();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)")
      .run(sessionId, node.id, "dev-impl@src-rig", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_token = 'tok-native-1', resume_type = 'claude_id' WHERE id = ?")
      .run(sessionId);

    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched" as const, sessionName: "forked@dst" } },
    }));
    const app = new Hono();
    const podInstantiator = { addMemberToPod: addMember } as unknown as PodRigInstantiator;
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("podInstantiator" as never, podInstantiator);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));

    const res = await app.request("/api/agent-images/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked" }),
    });
    expect(res.status).toBe(201);
    expect(addMember).toHaveBeenCalledTimes(1);
    const fragment = addMember.mock.calls[0]![2] as Record<string, unknown>;
    // 基线 RED：fragment 只转发 runtime/agent_ref/profile/cwd/codex_config_profile/
    // permission_policy——这四项会被丢弃。
    expect(fragment["model"]).toBe("claude-opus-5");
    expect(fragment["role"]).toBe("worker");
    expect(fragment["restore_policy"]).toBe("resume_if_possible");
    expect(fragment["label"]).toBe("Implementer");
    // 此前已转发的字段也仍会传递（回归底线）
    expect(fragment["agent_ref"]).toBe("local:agents/impl");
    expect(fragment["session_source"]).toMatchObject({ mode: "fork", ref: { kind: "native_id", value: "tok-native-1" } });
  });
});
