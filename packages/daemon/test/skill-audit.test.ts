import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { auditSkills, type SkillAuditEntry } from "../src/domain/skill-audit.js";
import type { SkillProvenanceEntry, SkillFrontmatter } from "../src/domain/skill-discovery.js";

function makeEntry(overrides: Partial<SkillProvenanceEntry> & { fmOverrides?: Record<string, unknown> }): SkillProvenanceEntry {
  const { fmOverrides, ...rest } = overrides;
  const baseFm: Record<string, unknown> = {
    name: rest.id ?? "test-skill",
    description: "A test skill",
    ...fmOverrides,
  };
  return {
    id: "test-skill",
    path: "/tmp/skills/test-skill",
    sourceRoot: "/tmp/skills",
    sourceKind: "rig_bundled",
    frontmatter: baseFm as SkillFrontmatter,
    body: "",
    shadowed: false,
    ...rest,
  };
}

describe("skill audit", () => {
  // freshness fixture 使用固定 observation 日期，而不是 CI 运行日期。
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-20T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  // 四 FIXTURE VERIFIED 矩阵（PRD + guard discriminator）

  it("(a) CLEAN：日期 + 真实 evidence source 通过", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "practical-passed-2026-06-15 against runtime tests",
            owner: "openrig-delivery",
            source_ref: "v0.4.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
    expect(result!.findings.filter((f) => f.class.includes("verified"))).toHaveLength(0);
    expect(result!.state).toBe("active");
  });

  it("(b) 仅日期：无 evidence source 的 last_verified 以 bare_verified 失败", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
    expect(result!.state).toBe("stale");
  });

  it("(b) 指向自身 SKILL.md 文件路径不会让 bare date 通过", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  it("(b) source_evidence 等于自身 SKILL.md 路径时以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  it("(b) source_evidence 经 .. normalize 后指向自身路径时以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/../test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence 为带尾斜杠的 skill directory 时以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "/tmp/skills/test-skill/",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) top-level verified 指向 normalize 后的自身路径时以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        verified: "2026-06-15 against /tmp/skills/test-skill/../test-skill/SKILL.md",
        metadata: { openrig: { owner: "test", source_ref: "v1" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence ./test-skill/SKILL.md（相对于 root）以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "./test-skill/SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence test-skill/（相对于 root 的 directory）以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "test-skill/",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) top-level verified 指向 ./test-skill/SKILL.md 时以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        verified: "2026-06-15 against ./test-skill/SKILL.md",
        metadata: { openrig: { owner: "test", source_ref: "v1" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(b) source_evidence 为 'SKILL.md'（裸 filename）时以 bare_verified 失败", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "SKILL.md",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  it("(c) 无日期：没有 verified 日期时以 missing_verified 失败", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("missing_verified");
    expect(result!.findings.some((f) => f.class === "missing_verified")).toBe(true);
  });

  it("(d) STALE：有日期 + source 但超过 freshness window 时以 stale_verified 失败", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2025-01-01",
            source_evidence: "practical-passed-2025-01-01",
            owner: "openrig-delivery",
            source_ref: "v0.1.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("stale_verified");
    expect(result!.findings.some((f) => f.class === "stale_verified")).toBe(true);
    expect(result!.state).toBe("stale");
  });

  // EXEMPT 轴
  it("exempt skill（status: historical-reference）没有 finding", () => {
    const entry = makeEntry({
      fmOverrides: {
        status: "historical-reference",
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.state).toBe("exempt");
    expect(result!.findings).toHaveLength(0);
  });

  // SHADOWED 不标记
  it("shadowed skill 没有 finding（非 active）", () => {
    const entry = makeEntry({
      shadowed: true,
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved" } },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.findings).toHaveLength(0);
  });

  // PROVENANCE 缺失
  it("owner 与 source_ref 缺失时标记为 missing_provenance", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            source_evidence: "verified against tests",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    const provFindings = result!.findings.filter((f) => f.class === "missing_provenance");
    expect(provFindings.length).toBeGreaterThanOrEqual(2);
  });

  // TOP-LEVEL VERIFIED 格式
  it("正确解析 top-level verified: <date> against <source>", () => {
    const entry = makeEntry({
      fmOverrides: {
        verified: "2026-06-10 against runtime integration tests",
        metadata: {
          openrig: {
            owner: "openrig-delivery",
            source_ref: "v0.4.0",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
    if (result!.verified.status === "verified") {
      expect(result!.verified.date).toBe("2026-06-10");
      expect(result!.verified.source).toBe("runtime integration tests");
    }
  });

  // READ-ONLY INVARIANT（结构性——audit 永不修改）
  it("auditSkills 无副作用地返回 entry", () => {
    const entries = [
      makeEntry({ id: "skill-a", fmOverrides: { metadata: { openrig: { stage: "factory-approved" } } } }),
      makeEntry({ id: "skill-b", fmOverrides: { metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test" } } } }),
    ];

    const { entries: results } = auditSkills(entries);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("skill-a");
    expect(results[1]!.id).toBe("skill-b");
  });

  // B1 回归：根据 checkMode result 输出 mirror drift finding
  it("mirrorDrift.stale 为 true 时输出 mirror drift finding", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test", owner: "test", source_ref: "v1" } },
      },
    });

    const { mirrorDriftFindings } = auditSkills([entry], {
      mirrorDrift: { stale: true, changes: ["skills/_canonical/openrig-user/SKILL.md", "skills/_canonical/openrig-builder/SKILL.md"] },
    });

    expect(mirrorDriftFindings).toHaveLength(2);
    expect(mirrorDriftFindings[0]!.class).toBe("mirror_drift");
    expect(mirrorDriftFindings[0]!.file).toContain("openrig-user");
  });

  it("mirrorDrift.stale 为 false 时不输出 mirror drift finding", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: { openrig: { stage: "factory-approved", last_verified: "2026-06-15", source_evidence: "test", owner: "test", source_ref: "v1" } },
      },
    });

    const { mirrorDriftFindings } = auditSkills([entry], { mirrorDrift: { stale: false, changes: [] } });
    expect(mirrorDriftFindings).toHaveLength(0);
  });

  // B3 回归：body（而非 frontmatter）中的 legacy banner 使 skill 豁免
  it("body 中的 legacy banner 使 skill 豁免", () => {
    const entry = makeEntry({
      fmOverrides: {},
    });
    (entry as { body: string }).body = "> **legacy** — this skill is historical.\n\nSome content.";

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.state).toBe("exempt");
    expect(result!.findings).toHaveLength(0);
  });

  // REV1 回归：无效 last_verified 日期 + 真实 source -> bare_verified，而非 verified
  it("无效 last_verified 日期（非日期 string）以 bare_verified 失败", () => {
    const entry = makeEntry({
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "not-a-date",
            source_evidence: "runtime integration tests",
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
    expect(result!.findings.some((f) => f.class === "bare_verified")).toBe(true);
  });

  // REV1 回归：只含自身路径的 array-valued sourced_from -> bare_verified
  it("只含 self-referential path 的 array sourced_from 以 bare_verified 失败", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            sourced_from: ["/tmp/skills/test-skill/SKILL.md", "./test-skill/SKILL.md"],
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("bare_verified");
  });

  // REV1：array sourced_from 至少有一个真实 non-self source -> verified
  it("含一个真实 source 的 array sourced_from 以 verified 通过", () => {
    const entry = makeEntry({
      path: "/tmp/skills/test-skill",
      fmOverrides: {
        metadata: {
          openrig: {
            stage: "factory-approved",
            last_verified: "2026-06-15",
            sourced_from: ["/tmp/skills/test-skill/SKILL.md", "runtime integration tests"],
            owner: "test",
            source_ref: "v1",
          },
        },
      },
    });

    const { entries: [result] } = auditSkills([entry]);
    expect(result!.verified.status).toBe("verified");
  });
});
