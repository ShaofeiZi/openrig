// P6(A)——refs→membership→ship-categories→disk 链路检查（PM pin 升级；
// 对 0.4.8/864cea6b 搁浅问题的类别绝杀）。每条列表都对照其消费者
// 端到端校验，使搁浅无处藏身：
//
//   Leg 1  refs ⊆ membership              ——agent.yaml 引用的一切都在 oracle 中存在
//   Leg 2  membership ⊆ SHIP_CATEGORIES   ——oracle 的每个 product_public 类别都被
//                                            mirror 的 ship 集消费（pipeline 层的
//                                            accept-and-drop 近亲：864cea6b 的 mirror
//                                            带了一个脚本从不消费的类别——
//                                            restored_role_pm_selected——故 PM 的
//                                            重新添加被静默丢弃、从未发货）
//   Leg 3  ship-set ⊆ disk                ——oracle 说要发货的每个 skill 都在盘上 pool 中存在
//
// 一个 bug 的三张面孔：864cea6b 删了 pod/pm 的 SKILL.md 文件（leg 3），PM 把它们
// 重新加进 mirror 从不读取的 product_public 类别（leg 2），而 agent.yaml 仍在引用
// 它们（leg 1）。本闸门让任何复发在 CI 中响亮失败，而非在 daemon 启动时才暴露。

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SHIP_CATEGORIES, shipSetFromMembership } from "../../../scripts/mirror-skills.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const AGENT_YAML = join(__dirname, "..", "specs", "agents", "shared", "agent.yaml");
const MEMBERSHIP = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "product-public-skills.generated.json"), "utf8"));
const LAYOUT = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "skill-edge-layout.generated.json"), "utf8"));

// oracle 发货、但仅存在于外部 founder 门禁 skill canon 的 skill：在那里编写、
// 已计入生成的 edge digest，但尚未镜像进本仓库（其源不在 git，founder mirror 输入
// ——OPENRIG_SKILL_CANON_ROOT + 权威 YAML——在此未设置，故无法从仓库恢复）。这是
// 仓库↔外部 canon 的同步缺口，由下一次 founder mirror 关闭，不是 864cea6b 那种
// 静默类别丢弃（leg 2 捕获后者）。下方守卫测试保持此集合最小且自管：每条必须是
// ship-set + digest 跟踪 + 仓库盘上缺失——故真正遗忘的搁浅永远无法借它藏身。
// 当前为空：oversight-team 与 retiring-and-inheriting-a-seat 经 2026-08-24
// mirror-apply 落地，其豁免自毁（下方最小性检查会对任何实际在盘上的条目失败）。
const EXTERNAL_CANON_PENDING = new Set<string>([]);

type Membership = Record<string, unknown>;
type AgentSkill = { id: string; path: string };

// The FULL oracle vocabulary: every skill named in any membership category. A skill agent.yaml
// references must appear SOMEWHERE here or the mirror has no basis to ship (or intentionally hold) it.
function fullMembershipSkills(m: Membership): Set<string> {
  const out = new Set<string>();
  const eat = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && out.add(x));
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(eat);
  };
  eat(m.product_public);
  eat(m.vendored_ship_with_provenance);
  eat(m.not_public);
  eat(m.pending_author_public);
  return out;
}

function agentSkills(yamlPath: string): AgentSkill[] {
  const doc = parseYaml(readFileSync(yamlPath, "utf8")) as {
    resources?: { skills?: AgentSkill[] };
  };
  return doc.resources?.skills ?? [];
}

// Leg 1——refs ⊆ membership。只有 `skills/` 路径条目由 oracle 治理；`runtime/` 片段
//（claude-settings、mcp、codex-config、activity-hooks）是打包配置，不是 skill。
function refsNotInMembership(skills: AgentSkill[], m: Membership): string[] {
  const known = fullMembershipSkills(m);
  return skills
    .filter((s) => typeof s.path === "string" && s.path.startsWith("skills/"))
    .map((s) => s.id)
    .filter((id) => !known.has(id));
}

// Leg 2——membership ⊆ SHIP_CATEGORIES。oracle 声明的每个 product_public 类别都必须被
// mirror 的 ship 集消费，否则整类 skill 会被 accept-and-drop。
function categoriesNotConsumed(m: Membership, shipCategories: readonly string[]): string[] {
  const declared = Object.keys((m.product_public as Record<string, unknown>) ?? {});
  const consumed = new Set(shipCategories);
  return declared.filter((c) => !consumed.has(c));
}

// Leg 3 — ship-set ⊆ disk. Every skill the oracle says ships resolves to an on-disk SKILL.md in
// EACH edge its layout declares (edge-aware: a flat edge like `plugin` places skills at its root; a
// categorized edge like `spec`/`canonical` places them under their category). Reported as skill@edge.
type Layout = {
  edges: Record<string, { path: string; layout: string }>;
  skills?: Record<string, { edges?: string[]; category?: string | null }>;
};
function shipSetNotOnDisk(m: Membership, layout: Layout, repoRoot: string): string[] {
  const missing: string[] = [];
  for (const skill of shipSetFromMembership(m)) {
    const sl = layout.skills?.[skill];
    if (!sl?.edges?.length) {
      missing.push(`${skill} (no layout edges)`);
      continue;
    }
    for (const edge of sl.edges) {
      const ec = layout.edges[edge];
      const edgeRoot = join(repoRoot, ec.path);
      const category = ec.layout === "flat" ? null : sl.category ?? null;
      const dir = category ? join(edgeRoot, category, skill) : join(edgeRoot, skill);
      if (!existsSync(join(dir, "SKILL.md"))) missing.push(`${skill}@${edge}`);
    }
  }
  return missing;
}

describe("P6(A) 技能引用→成员关系→发布类别→磁盘链（0.4.8 消除搁浅类别）", () => {
  it("第 1 段——agent.yaml 中每个 skills/ 路径引用都存在于判定源成员关系中", () => {
    const stranded = refsNotInMembership(agentSkills(AGENT_YAML), MEMBERSHIP);
    expect(stranded, `agent.yaml references NOT in the oracle: ${stranded.join(", ")}`).toEqual([]);
  });

  it("第 2 段——判定源中的每个 product_public 类别都被镜像 SHIP_CATEGORIES 消费", () => {
    const dropped = categoriesNotConsumed(MEMBERSHIP, SHIP_CATEGORIES);
    expect(dropped, `oracle categories the mirror silently drops: ${dropped.join(", ")}`).toEqual([]);
  });

  it("第 3 段——判定源发布集合中的每项技能都存在于各声明边的磁盘上", () => {
    const missing = shipSetNotOnDisk(MEMBERSHIP, LAYOUT, REPO_ROOT).filter(
      (v) => !EXTERNAL_CANON_PENDING.has(v.split("@")[0]),
    );
    expect(missing, `ship-set skills with no on-disk SKILL.md: ${missing.join(", ")}`).toEqual([]);
  });

  // external-canon-pending 白名单必须保持最小：每条必须 (a) 在 ship 集中，
  // (b) LAYOUT 跟踪——founder layout 仍要求它，故控制面陈旧检查对其缺失保持
  // 响亮（layout-missing），仅命名白名单容忍它——且 (c) 仓库盘上确实缺失。
  // 不在 ship 集、不在 layout、或实际在盘上的条目都是陈旧的，在此失败，
  // 故真实搁浅永远无法被静默停进白名单。
  // 注意：该属性是 LAYOUT 跟踪，不是 digest 跟踪——disk-truth digest 重新生成
  // 正确地为盘上不存在的文件省略 digest（幽灵的哈希无意义）；"响亮"来自
  // layout 要求它（layout = 权威，disk = 现实）。
  it("external-canon-pending 白名单最小且自校验（不隐藏真实搁浅）", () => {
    const shipSet = new Set(shipSetFromMembership(MEMBERSHIP));
    const layoutTracked = new Set(
      Object.entries((LAYOUT.skills ?? {}) as Record<string, { edges?: string[] }>)
        .filter(([, entry]) => (entry.edges?.length ?? 0) > 0)
        .map(([skill]) => skill),
    );
    const stillMissing = new Set(shipSetNotOnDisk(MEMBERSHIP, LAYOUT, REPO_ROOT).map((v) => v.split("@")[0]));
    for (const skill of EXTERNAL_CANON_PENDING) {
      expect(shipSet.has(skill), `${skill} must be in the oracle ship set`).toBe(true);
      expect(layoutTracked.has(skill), `${skill} must be layout-tracked (loud via layout-missing, not silent)`).toBe(true);
      expect(stillMissing.has(skill), `${skill} must be genuinely absent from repo disk`).toBe(true);
    }
  });

  // Each leg must actually CATCH its stranding face — synthetic fixtures reproducing 864cea6b.
  it("在每一段捕获 864cea6b 搁浅问题（fixture 应失败）", () => {
    // Leg 1: a referenced skill absent from the oracle.
    expect(
      refsNotInMembership([{ id: "orphan-skill", path: "skills/pods/orphan-skill" }], { product_public: {} }),
    ).toEqual(["orphan-skill"]);
    // Leg 2：mirror 从不消费的 oracle 类别（正是 864cea6b 的面孔）。
    expect(
      categoriesNotConsumed({ product_public: { restored_role_pm_selected: ["x"] } }, ["clean"]),
    ).toEqual(["restored_role_pm_selected"]);
    // Leg 3: a ship-set skill declared for the spec edge but with no file on disk.
    expect(
      shipSetNotOnDisk(
        { product_public: { clean: ["ghost-skill"] } },
        {
          edges: { spec: { path: "packages/daemon/specs/agents/shared/skills", layout: "categorized" } },
          skills: { "ghost-skill": { edges: ["spec"], category: "pods" } },
        },
        REPO_ROOT,
      ),
    ).toEqual(["ghost-skill@spec"]);
  });
});
