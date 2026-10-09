import { describe, expect, it } from "vitest";
import {
  resolvePermissionPolicyAttachment,
  validatePermissionPolicyRef,
} from "../src/domain/permission-policy/policy-ref.js";
import { validatePolicySpec } from "../src/domain/permission-policy/policy-spec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import {
  createFullTestDb,
  createTestApp,
} from "./helpers/test-app.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const INVALID_BUT_READABLE_CONFIG = `---
source: custom
name: incomplete-config
surface: config
policy_schema_version: 1
description: 缺少必填配置字段
---
正文
`;

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

function minimalSpec(permissionPolicy: unknown): Record<string, unknown> {
  return {
    version: "0.2",
    name: "r2-seamb-repro",
    permission_policy: permissionPolicy,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        runtime: "claude-code",
        agent_ref: "local:agents/impl",
        profile: "default",
        cwd: ".",
      }],
      edges: [],
    }],
    edges: [],
  };
}

describe("review50-r2 独立接缝 B 对抗分支", () => {
  it("拒绝逐段引用字符集之外的字符", () => {
    expect(validatePermissionPolicyRef("policies/team?.md", "permission_policy")).not.toBeNull();
  });

  it("拒绝显式 null，因为附件语法只允许两种字符串形式或缺省", () => {
    expect(RigSpecSchema.validate(minimalSpec(null)).valid).toBe(false);
  });

  it("不将可读但无效的配置内容标记为已安全重新推导", () => {
    const attachment = resolvePermissionPolicyAttachment("policies/incomplete.md", "/rig", {
      readFile: () => INVALID_BUT_READABLE_CONFIG,
    });
    const validity = validatePolicySpec({
      source: "custom",
      name: "incomplete-config",
      surface: "config",
      policy_schema_version: 1,
      description: "缺少必填配置字段",
    });
    expect(validity.ok).toBe(false);
    expect(attachment.contentResolved).toBe(false);
  });

  it("以继承的装备姿态启动结构化 add-member", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => {
        bindings.push(binding);
        return { ok: true };
      },
      checkReady: async () => ({ ready: true }),
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (p) => p.includes("agents/impl"),
          readFile: (p) => {
            if (p.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`未找到：${p}`);
          },
        },
      });
      const materialized = await setup.podInstantiator.materializeStructured(
        minimalSpec("builtin:yolo"),
        "/rig",
      );
      expect(materialized.ok).toBe(true);
      const rigId = (materialized as { ok: true; result: { rigId: string } }).result.rigId;
      const added = await setup.podInstantiator.addMemberToPod(
        rigId,
        "dev",
        {
          id: "late",
          runtime: "claude-code",
          agent_ref: "local:agents/impl",
          profile: "default",
          cwd: ".",
        },
        "/different-operation-root",
      );
      expect(added.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      const lateId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string }).id;
      expect(setup.rigRepo.getNodePolicyProvenance(lateId)?.launchPosture).toBe("full_bypass");
      expect.soft(bindings[0]?.launchPosture).toBe("full_bypass");
    } finally {
      db.close();
    }
  });

  it("以继承的装备姿态启动结构化工作组扩展", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => {
        bindings.push(binding);
        return { ok: true };
      },
      checkReady: async () => ({ ready: true }),
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (p) => p.includes("agents/impl"),
          readFile: (p) => {
            if (p.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`未找到：${p}`);
          },
        },
      });
      const materialized = await setup.podInstantiator.materializeStructured(
        minimalSpec("builtin:yolo"),
        "/rig",
      );
      expect(materialized.ok).toBe(true);
      const rigId = (materialized as { ok: true; result: { rigId: string } }).result.rigId;
      const expanded = await setup.rigExpansionService.expand({
        rigId,
        rigRoot: "/different-operation-root",
        pod: {
          id: "later",
          label: "Later",
          members: [{
            id: "worker",
            runtime: "claude-code",
            agentRef: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }],
          edges: [],
        },
      });
      expect(expanded.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      const workerId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'later.worker'").get() as { id: string }).id;
      expect.soft(bindings[0]?.launchPosture).toBe("full_bypass");
      expect.soft(setup.rigRepo.getNodePolicyProvenance(workerId)?.launchPosture).toBe("full_bypass");
    } finally {
      db.close();
    }
  });
});
