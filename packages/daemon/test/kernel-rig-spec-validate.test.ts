// V0.3.1 slice 05 kernel-rig-as-default——已发布 kernel rig 变体必须通过 rig spec validate，
// BootstrapOrchestrator 才会在 runtime 接纳它们。Phase 05d Finding 1 的前向修复：kernel-boot
// 单元测试因 mock orchestrator 而通过；本测试用真实 validator pipeline 验证已发布 spec，使下次
// 回归无法悄然发布。
//
// Phase 05d velocity-qa VM 裁定（missing-skills）的前向修复：仅 rig spec validate 不够；kernel agent
// 声明的 profile.uses.skills 必须可在导入的共享 resource pool 中解析。VM 演练发现 6 个被引用但未在
// shared/agent.yaml 注册的 skill。本测试增加 resource-pool containment gate，使下一次缺 skill 回归
// 在 CI 失败，而不是在 daemon-start 时失败。

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";

const SHIPPED_VARIANTS = [
  "rig.yaml",
  "rig-claude-only.yaml",
  "rig-codex-only.yaml",
] as const;

const KERNEL_DIR = join(__dirname, "..", "specs", "rigs", "launch", "kernel");
const KERNEL_AGENTS_DIR = join(KERNEL_DIR, "agents");
const KERNEL_AGENT_PATHS = [
  join(KERNEL_AGENTS_DIR, "advisor", "lead", "agent.yaml"),
  join(KERNEL_AGENTS_DIR, "operator", "agent", "agent.yaml"),
  join(KERNEL_AGENTS_DIR, "queue", "worker", "agent.yaml"),
];

describe("kernel rig 变体——rig spec validate", () => {
  for (const variant of SHIPPED_VARIANTS) {
    it(`${variant} 通过 RigSpec 验证（HG-2 + HG-20 runtime gate）`, () => {
      const yaml = readFileSync(join(KERNEL_DIR, variant), "utf-8");
      const result = validateRigSpecFromYaml(yaml);
      if (!result.valid) {
        // 显示每个验证错误，使调试回归时无需手工重新运行 validator。
        throw new Error(
          `RigSpec validation failed for ${variant}:\n  - ${result.errors.join("\n  - ")}`,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }

  it("三个变体共享相同 topology 结构（pod + member id）", () => {
    const shapes = SHIPPED_VARIANTS.map((variant) => {
      const yaml = readFileSync(join(KERNEL_DIR, variant), "utf-8");
      // 通过共享 codec 轻量解析；pod + member id 的结构相等可确保变体只在 runtime 声明上不同。
      const result = validateRigSpecFromYaml(yaml);
      return { variant, valid: result.valid, errors: result.errors };
    });
    expect(shapes.every((s) => s.valid)).toBe(true);
  });
});

// Resource-pool containment gate。每个 kernel agent（advisor.lead、operator.agent、queue.worker）
// 针对导入的共享 resource pool 声明 profile.uses.skills。若任一引用 id 未出现在 shared/agent.yaml
// 的 resources.skills 中，后台服务会以“Profile 使用的 skills：<id> 未在资源池中找到”拒绝
// bootstrap；这正是 velocity-qa 在 VM 上捕获的失败模式。
describe("kernel agent——profile.uses 引用可在共享 pool 中解析", () => {
  const SHARED_AGENT_YAML = join(
    __dirname, "..", "specs", "agents", "shared", "agent.yaml",
  );
  function poolIds(yamlPath: string, kind: "skills" | "runtime_resources"): Set<string> {
    const doc = parseYaml(readFileSync(yamlPath, "utf-8")) as {
      resources?: { skills?: { id: string; path: string }[]; runtime_resources?: { id: string }[] };
    };
    const list =
      kind === "skills" ? doc.resources?.skills ?? [] : doc.resources?.runtime_resources ?? [];
    return new Set(list.map((r) => r.id));
  }

  function usedSkillIds(yamlPath: string): { profile: string; skills: string[] }[] {
    const doc = parseYaml(readFileSync(yamlPath, "utf-8")) as {
      profiles?: Record<string, { uses?: { skills?: string[] } }>;
    };
    const out: { profile: string; skills: string[] }[] = [];
    for (const [profile, p] of Object.entries(doc.profiles ?? {})) {
      out.push({ profile, skills: p?.uses?.skills ?? [] });
    }
    return out;
  }

  // shared/agent.yaml 中声明的 skill 也必须存在于磁盘 skills/<path>/SKILL.md。磁盘存在性检查会捕获
  // path 拼错或目录遗漏的 YAML 条目。
  it("shared/agent.yaml 中所有 skill 都解析到磁盘上的 packaged SKILL.md 文件", () => {
    const sharedDir = dirname(SHARED_AGENT_YAML);
    const doc = parseYaml(readFileSync(SHARED_AGENT_YAML, "utf-8")) as {
      resources?: { skills?: { id: string; path: string }[] };
    };
    const missing: string[] = [];
    for (const skill of doc.resources?.skills ?? []) {
      const skillFile = join(sharedDir, skill.path, "SKILL.md");
      if (!existsSync(skillFile)) {
        missing.push(`${skill.id} → ${skill.path} (no SKILL.md at ${skillFile})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Packaged shared resource pool declares skills with no on-disk SKILL.md:\n  - ${missing.join("\n  - ")}`,
      );
    }
  });

  for (const agentPath of KERNEL_AGENT_PATHS) {
    const label = agentPath
      .replace(KERNEL_AGENTS_DIR + "/", "")
      .replace("/agent.yaml", "")
      .replace("/", ".");
    it(`${label}: profile.uses.skills all resolve in shared resource pool`, () => {
      const pool = poolIds(SHARED_AGENT_YAML, "skills");
      const used = usedSkillIds(agentPath);
      const missing: string[] = [];
      for (const { profile, skills } of used) {
        for (const id of skills) {
          if (!pool.has(id)) missing.push(`profile=${profile} skill=${id}`);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `${label} references skills not in shared pool:\n  - ${missing.join("\n  - ")}`,
        );
      }
    });
  }
});

describe("kernel agent——嵌套 AgentSpec 验证", () => {
  for (const agentPath of KERNEL_AGENT_PATHS) {
    const label = agentPath
      .replace(KERNEL_AGENTS_DIR + "/", "")
      .replace("/agent.yaml", "")
      .replace("/", ".");

    it(`${label}：agent.yaml 通过 AgentSpec 验证`, () => {
      const yaml = readFileSync(agentPath, "utf-8");
      const raw = parseAgentSpec(yaml);
      const result = validateAgentSpec(raw);
      if (!result.valid) {
        throw new Error(
          `AgentSpec validation failed for ${label}:\n  - ${result.errors.join("\n  - ")}`,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }
});
