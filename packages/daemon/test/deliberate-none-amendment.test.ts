// DELIBERATE-NONE 修正（Lane-A hop 2）—— 固定已裁定的记录形式：
// `RULED-FORM-deliberate-none-2026-08-04.md` sha256
// 5f37e40fbcdcf220dd103783d64fcac2e52945e96f736918abc2d8e84c768dc0（PM 已确认）：
// `permission_policy: none` 表示已记录的有意选择；第三种来源为 `deliberate_none`；
// 绝不解析到任何文件；姿态与 absent 完全相同（权限差异为零，仅记录/溯源发生变化）。
// P1（如实性核心）和 P2（姿态一致性）是该裁定形式在此 lane 必须固定的不变量；
// P3（仅在显式选择时写入）属于 Lane-B。
import { describe, expect, it } from "vitest";
import {
  resolvePermissionPolicyAttachment,
  validatePermissionPolicyRef,
} from "../src/domain/permission-policy/policy-ref.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (p) => p.includes("agents/impl"),
    readFile: (p) => {
      if (p.includes("agents/impl")) return AGENT_YAML;
      throw new Error(`not found: ${p}`);
    },
  };
}

function rigYaml(policyLine: string): string {
  return `version: "0.2"
name: deliberate-none-probe
${policyLine}pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        cwd: .
    edges: []
`;
}

describe("deliberate-none 解析（裁定形式 5f37e40f）", () => {
  it("将 'none' 解析为 origin=deliberate_none 和 floor 姿态，且绝不访问文件", () => {
    const att = resolvePermissionPolicyAttachment("none", "/any/declaring/dir", {
      readFile: () => {
        throw new Error("deliberate_none must never read a file");
      },
    });
    expect(att.ref).toBe("none");
    expect(att.origin).toBe("deliberate_none");
    expect(att.launchPosture).toBe("floor");
    expect(att.resolvedTarget).toBeUndefined(); // 不可引用，A3 防抢占边界保持有效
    expect(att.declaringDir).toBeUndefined();
  });

  it("只有字面值 'none' 才是 token，近似拼写仍是普通自定义引用", () => {
    expect(validatePermissionPolicyRef("none", "permission_policy")).toBeNull();
    // 'None' 和 'none.md' 与此前一样通过 A2 路径字符集校验；它们是自定义文件引用，
    // 而不是 token，解析结果会证明这种区别。
    for (const nearMiss of ["None", "none.md"]) {
      expect(validatePermissionPolicyRef(nearMiss, "permission_policy")).toBeNull();
      const att = resolvePermissionPolicyAttachment(nearMiss, "/x", { readFile: () => { throw new Error("missing"); } });
      expect(att.origin).toBe("custom"); // 绝不是已记录选择的来源
      expect(att.origin).not.toBe("deliberate_none");
    }
  });
});

describe("P1 如实性核心——缺失策略的 spec 绝不被重写、升级或报告为 deliberate_none", () => {
  it("对缺失策略的 spec 执行预检发现时如实报告缺失，任何位置都没有 deliberate_none", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml(""),
      rigRoot: "/probe/root",
      fsOps: fsOps(),
    });
    expect(result.ready).toBe(true);
    const joined = result.warnings.join("\n");
    expect(joined).toContain("dev.impl：缺少 permission_policy；launch_posture=floor");
    expect(joined).not.toContain("deliberate_none");
    expect(joined).not.toContain("有意选择");
  });

  it("物化缺失策略的 spec 时不持久化策略溯源，保持 null 且绝不伪造 'none' 记录", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup.podInstantiator.materialize(rigYaml(""), "/probe/root");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const row = db.prepare(
        "SELECT policy_origin, policy_launch_posture FROM nodes WHERE logical_id = 'dev.impl'",
      ).get() as { policy_origin: string | null; policy_launch_posture: string | null };
      expect(row.policy_origin).toBeNull(); // 缺失就是缺失，旧 spec 绝不声称用户作过不存在的选择
      expect(row.policy_launch_posture).toBeNull();
      const rig = db.prepare("SELECT permission_policy FROM rigs LIMIT 1").get() as { permission_policy: string | null };
      expect(rig.permission_policy).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("P2 姿态一致性——absent 和 none 仅在记录上有区别", () => {
  it("发现结果都报告 launch_posture=floor，仅记录措辞不同，物化结果同样成功", async () => {
    const absent = await rigPreflight({ rigSpecYaml: rigYaml(""), rigRoot: "/probe/root", fsOps: fsOps() });
    const none = await rigPreflight({ rigSpecYaml: rigYaml("permission_policy: none\n"), rigRoot: "/probe/root", fsOps: fsOps() });
    expect(absent.ready).toBe(true);
    expect(none.ready).toBe(true);
    const a = absent.warnings.find((w) => w.startsWith("dev.impl："))!;
    const n = none.warnings.find((w) => w.startsWith("dev.impl：permission_policy"))!;
    expect(a).toMatch(/launch_posture=floor$/);
    expect(n).toMatch(/launch_posture=floor$/); // 姿态声明字节完全一致
    expect(n).toContain("已记录的有意选择"); // 记录是唯一差异
    expect(a).toContain("缺少 permission_policy");
  });

  it("附件姿态一致：resolve('none') 姿态等于缺失时的 floor，持久溯源携带 deliberate_none 记录", async () => {
    const att = resolvePermissionPolicyAttachment("none", "/x", { readFile: () => { throw new Error("no read"); } });
    expect(att.launchPosture).toBe("floor"); // 权限与缺失时完全相同，差异为零
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup.podInstantiator.materialize(rigYaml("permission_policy: none\n"), "/probe/root");
      expect(outcome.ok).toBe(true);
      const row = db.prepare(
        "SELECT policy_origin, policy_launch_posture FROM nodes WHERE logical_id = 'dev.impl'",
      ).get() as { policy_origin: string | null; policy_launch_posture: string | null };
      expect(row.policy_origin).toBe("deliberate_none"); // 已记录的意图本身就是溯源
      expect(row.policy_launch_posture).toBe("floor");
    } finally {
      db.close();
    }
  });
});
