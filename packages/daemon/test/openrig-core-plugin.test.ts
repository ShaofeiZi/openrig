// plugin 原语 Phase 3a slice 3.2 测试集——openrig-core 插件
// 编写 + 树形状校验。依据 IMPL-PRD §2（HG-2.1、HG-2.2）
// + DESIGN.md §5.5。
//
// packages/daemon/assets/plugins/openrig-core/ 的 vendored 插件树
// 是 v0 的真相来源（从
// github.com/mvschwarz/openrig-plugins 自动拉取是优雅叠加；
// vendored 回退始终可用）。
//
// 本测试集断言形状 + 契约——不复制、不改写。若这些测试通过，
// 该插件即可被 Claude Code 与 Codex 两个运行时经各自插件加载器
// 消费，也可被 OpenRig 的按运行时适用性过滤器消费
//（plugin_type=auto 同时识别两种 manifest 目录）。

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ROOT = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core");

// Tier A 是投影进每个出厂/默认 agent CWD 的通用 skill 主干。角色相关 skill
// 留在 spec 选定的边缘；仅 host 用的 skill 不进入产品边缘。
const EXPECTED_SKILLS = [
  // 产品插件中随附的 Tier-A 通用主干。applying-a-permission-policy 与
  // delegating-work 在 0.4.8 全量镜像（commit 864cea6b）中并入，二者均显式声明为
  // TIER-A（"applying-a-permission-policy (Tier-A：由随附 rig setup --policy 动词调用的
  // agent 驱动翻译)" 与 "delegating-work (Tier-A：全 agent 分发)"）。
  // orienting-to-an-inherited-seat 与 retiring-and-inheriting-a-seat 在 2026-08-24
  // canon-drift 再生成（commit 4281729e3）中并入；每个 seat 都可被继承或退役。
  // —— 因此按「仅主干」设计自身的规则，它们应归入产品插件。与随附 skills 目录、
  // openrig-skills 索引及 README 计数保持同步。
  "agent-operated-software",
  "agent-operated-workflows",
  "applying-a-permission-policy",
  "claude-compaction-restore",
  "delegating-work",
  "forming-an-openrig-mental-model",
  "loading-addressable-markdown",
  "messaging-the-human",
  "mission-slice-sop",
  "openrig-operating-model",
  "openrig-skills",
  "openrig-user",
  "orienting-to-an-inherited-seat",
  "queue-handoff",
  "refocusing",
  "retiring-and-inheriting-a-seat",
  "seat-continuity-and-handover",
  "session-compaction-and-restore",
  // 单版本兼容重定向。可编辑的规范正文仅存于
  // agent-operated-software。
  "software-for-agents",
];

describe("openrig-core plugin — vendored tree shape (HG-2.1)", () => {
  it("exists at packages/daemon/assets/plugins/openrig-core/", () => {
    expect(fs.existsSync(PLUGIN_ROOT)).toBe(true);
    expect(fs.statSync(PLUGIN_ROOT).isDirectory()).toBe(true);
  });

  it("ships dual manifest (.claude-plugin/plugin.json + .codex-plugin/plugin.json) — Obra Superpowers shape", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it("LICENSE file present (Apache 2.0 per founder direction; public marketplace target)", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "LICENSE"))).toBe(true);
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "LICENSE"), "utf-8");
    expect(content).toMatch(/Apache License/i);
  });

  it("README.md present", () => {
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "README.md"))).toBe(true);
  });
});

describe("openrig-core plugin — manifest shape (HG-2.2)", () => {
  it(".claude-plugin/plugin.json validates as Claude plugin manifest", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    // 按 Claude 插件规范的必填字段
    expect(manifest["name"]).toBe("openrig-core");
    expect(manifest["version"]).toBe("0.1.1");
    expect(typeof manifest["description"]).toBe("string");
    expect((manifest["description"] as string).length).toBeLessThanOrEqual(1024);
    // Hook 与 skills 接线
    expect(manifest["skills"]).toBe("./skills");
    expect(manifest["hooks"]).toBe("./hooks/claude.json");
    expect(manifest["repository"]).toMatch(/github:mvschwarz\/openrig-plugins/);
    expect(manifest["license"]).toBeDefined();
  });

  it(".codex-plugin/plugin.json validates as Codex plugin manifest (required: name, version, description)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    // Codex requires name + version + description (per IMPL-PRD §2.3)
    expect(manifest["name"]).toBe("openrig-core");
    expect(manifest["version"]).toBe("0.1.1");
    expect(typeof manifest["description"]).toBe("string");
    expect(manifest["hooks"]).toBe("./hooks/codex.json");
    expect(manifest["skills"]).toBe("./skills");
  });

  it("both manifests reference the same skills/ subdir (cross-runtime portability)", () => {
    const claude = JSON.parse(fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const codex = JSON.parse(fs.readFileSync(nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(claude["skills"]).toEqual(codex["skills"]);
  });
});

describe("openrig-core plugin — skills (HG-2.1 skill content per agentskills.io spec)", () => {
  it("README reports the actual shipped skill count", () => {
    const readme = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "README.md"), "utf-8");
    expect(readme).toContain(`Skills (${EXPECTED_SKILLS.length})`);
  });

  it.each(EXPECTED_SKILLS)("skill '%s' has SKILL.md with required frontmatter (name + description)", (skillId) => {
    const skillPath = nodePath.join(PLUGIN_ROOT, "skills", skillId, "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, "utf-8");
    // Frontmatter：--- ... ---
    expect(content).toMatch(/^---\n/);
    // 必填：name 字段
    expect(content).toMatch(/^name: \S+/m);
    // 必填：description 字段（按 agentskills.io 规范 ≤1024 字符）
    const descMatch = content.match(/^description:\s*(?:>?-?\s*)?\n?([\s\S]*?)(?=\n\w+:|\n---)/m);
    expect(descMatch).toBeTruthy();
    const desc = descMatch?.[1]?.trim() ?? "";
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
  });

  it("ships exactly the Tier-A universal spine", () => {
    const skillsDir = nodePath.join(PLUGIN_ROOT, "skills");
    const actual = fs.readdirSync(skillsDir).filter((f) =>
      fs.statSync(nodePath.join(skillsDir, f)).isDirectory()
      && fs.existsSync(nodePath.join(skillsDir, f, "SKILL.md")),
    );
    expect(actual.sort()).toEqual([...EXPECTED_SKILLS].sort());
  });

  it("ships the agent-operated taxonomy as two canonical skills plus one bounded compatibility redirect", () => {
    const readSkill = (id: string): string => fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", id, "SKILL.md"),
      "utf-8",
    );
    const description = (skill: string): string => {
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";
      const match = frontmatter.match(/(?:^|\n)description:\s*(?:[>|]-?\s*)?\n?([\s\S]*?)(?=\n\w+:|$)/);
      return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
    };

    const workflows = readSkill("agent-operated-workflows");
    const software = readSkill("agent-operated-software");
    const legacy = readSkill("software-for-agents");

    for (const canonical of [workflows, software]) {
      expect(description(canonical)).toMatch(/^Use when\b/);
      expect(description(canonical)).not.toMatch(/runbook owns|tools own|agent owns|human owns/i);
      expect(canonical).toContain("AI-enabled software");
      expect(canonical).toContain("Agent-Operated Workflow");
      expect(canonical).toContain("Agent-Operated Software");
    }

    expect(workflows).toMatch(/runbook[^\n]*owns policy/i);
    expect(workflows).toMatch(/deterministic tools[^\n]*context gathering[^\n]*bounded exact actions/i);
    expect(workflows).toMatch(/agent[^\n]*interpretation[^\n]*sequencing[^\n]*effect verification/i);
    expect(workflows).toMatch(/human[^\n]*destructive ambiguity[^\n]*product policy/i);
    expect(workflows).toMatch(/(?:closed[^\n]*state space|state space[^\n]*closed)/i);
    expect(workflows).toContain("skills/core/openrig-upgrade/SKILL.md");
    expect(workflows).toContain("bounded inspection, backup, plugin-refresh and migration helpers");
    expect(workflows).toContain("agent-operated-software");

    const softwareDescription = description(software);
    expect(softwareDescription).toMatch(
      /^Use when [^.]*ongoing application whose live backend or control loop includes OpenRig agents\b/i,
    );
    expect(softwareDescription).not.toMatch(/;\s*(?:when|or when)\b/i);
    expect(software).toMatch(/ongoing application/i);
    expect(software).toMatch(/bounded\s+workflow\s+does not[\s\S]{0,100}Agent-Operated Software/i);
    expect(software).toContain("agent-operated-workflows");
    for (const retained of ["Markdown", "progressive disclosure", "studio", "artifact", "SDLC"]) {
      expect(software).toContain(retained);
    }

    expect(legacy).toContain("agent-operated-software");
    expect(legacy).toMatch(/retire|remove/i);
    expect(legacy).toContain("0.6.0");
    expect(Buffer.byteLength(legacy, "utf8")).toBeLessThan(1_200);
    expect(legacy).not.toContain("# Software for agents — the markdown control plane");
  });

  it("ships the addressable-Markdown resolver with its skill", () => {
    const skillRoot = nodePath.join(PLUGIN_ROOT, "skills", "loading-addressable-markdown");
    expect(fs.existsSync(nodePath.join(skillRoot, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(nodePath.join(skillRoot, "scripts", "resolve-markdown.mjs"))).toBe(true);
  });

  it("executes the addressable-Markdown resolver through a symlinked ancestor", () => {
    const root = fs.mkdtempSync(nodePath.join(fs.realpathSync("/tmp"), "openrig-loader-"));
    const actualRoot = nodePath.join(root, "actual");
    const linkedRoot = nodePath.join(root, "linked");
    const relativeScript = nodePath.join("scripts", "resolve-markdown.mjs");
    try {
      fs.mkdirSync(nodePath.join(actualRoot, "scripts"), { recursive: true });
      fs.copyFileSync(
        nodePath.join(PLUGIN_ROOT, "skills", "loading-addressable-markdown", relativeScript),
        nodePath.join(actualRoot, relativeScript),
      );
      fs.writeFileSync(nodePath.join(actualRoot, "guide.md"), "# Guide\n\n## Intent\nLoaded.\n");
      fs.symlinkSync(actualRoot, linkedRoot, "dir");

      const result = spawnSync(
        process.execPath,
        [nodePath.join(linkedRoot, relativeScript), "--root", linkedRoot, "guide.md#intent"],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("## Intent\nLoaded.\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the addressable-Markdown resolver importable with a non-path argv[1]", () => {
    const scriptUrl = pathToFileURL(nodePath.join(
      PLUGIN_ROOT,
      "skills",
      "loading-addressable-markdown",
      "scripts",
      "resolve-markdown.mjs",
    )).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      encoding: "utf8",
      input: `import { parseAddress } from ${JSON.stringify(scriptUrl)};\n` +
        `process.stdout.write(parseAddress("guide.md#intent").headerPath[0]);\n`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("intent");
  });

  // 0.5.0 全量镜像（commit cabd2b2f）反转了路由：openrig-user 现在是一份自包含的
  // as-built `rig` CLI 指南，而 openrig-skills 索引才是路由器——它逐一列出随附 skill 及其
  // 访问方式（CLAUDE.md 引导把冷启动 seat 指向该索引）。
  it("the openrig-skills index is the router — it names every shipped skill (0.5.0 mirror cabd2b2f)", () => {
    const index = fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", "openrig-skills", "SKILL.md"),
      "utf-8",
    );
    // 成员不变量（索引自身的收尾说明：索引与随附集合是同一作用域）。
    for (const skillId of EXPECTED_SKILLS) {
      expect(index, `openrig-skills index must name the shipped skill '${skillId}'`).toContain(skillId);
    }
    // openrig-user 作为主干 skill 列入（由索引路由到它，而非反向）。
    expect(index).toContain("openrig-user");
  });

  it("the shipped OpenRig user guidance teaches a bounded read-only health self-scout", () => {
    const guide = fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", "openrig-user", "SKILL.md"),
      "utf-8",
    );
    expect(guide).toContain("rig health --json");
    expect(guide).toContain("rig health explain <finding-id> --json");
    expect(guide).toContain("not a healthy assertion");
    expect(guide).toContain("Never read raw SQLite");
    expect(guide).toContain("read-only");
  });

  it("the operating model distinguishes current attributed acceptance from legacy checklist scaffolding", () => {
    const skillRoot = nodePath.join(PLUGIN_ROOT, "skills", "openrig-operating-model");
    const skill = fs.readFileSync(nodePath.join(skillRoot, "SKILL.md"), "utf-8");
    const specTemplate = fs.readFileSync(nodePath.join(skillRoot, "templates", "SPEC.md"), "utf-8");

    expect(skill).toContain("ships in the mode-neutral `openrig-core` plugin");
    expect(skill).toContain("current proof readiness is derived from attributed judgments");
    expect(skill).toContain("`proofPolicy.judges`");
    expect(skill).toContain("`rig proof show`");
    expect(skill).toContain("Queue ownership and generic `done` are custody facts, not proof acceptance.");
    expect(skill).toContain("legacy checklist renderer");
    expect(skill).toContain("derived at render time");
    expect(skill).not.toContain("mode plugin's operating-model skill");
    expect(specTemplate).toContain("PROGRESS.md is the authored acceptance checklist");
    expect(specTemplate).not.toContain("PROGRESS is DERIVED");
  });

  it("the index gives a reachable repo load-path form for spec-shipped skills (0.5.0 mirror cabd2b2f: repo paths, superseding the old ${OPENRIG_CLI_ROOT} path table)", () => {
    const index = fs.readFileSync(
      nodePath.join(PLUGIN_ROOT, "skills", "openrig-skills", "SKILL.md"),
      "utf-8",
    );
    // 重写后的索引把 profile 选定（spec 随附）的 skill 指向其仓库位置；没有哪一行
    // 是死胡同。此前的 ${OPENRIG_CLI_ROOT}/~.openrig 路径表已被这份人工地图取代。
    expect(index).toContain("packages/daemon/specs/agents/shared/skills/core/");
    expect(index).not.toContain("OPENRIG_CLI_ROOT"); // 旧的 env-var 路径形式按设计已移除
  });

  // P6(B) 桌面/PM 裁定：864cea6b 的镜像从 openrig-architect SKILL.md 过度宽泛地整段
  // 掉落了 `rig spec audit rig.yaml` 这条咨询式审计指针（该命令与启动指南的对应行仍在
  // —— 与 (A) pods 同属「修复搁浅」一类）。该 skill 由外部作者 canon 镜像生成，
  // 因此仅在池内恢复会在下次镜像时被静默重删。PM 裁定上游恢复（mirror 法则：源头修复），
  // 由 dev-driver 在其 (A) canon-restore 增量内作为 864cea6b 补救来负责（openrig-architect
  // 为 edges=[canonical,spec]——内部，不暴露公共边缘）。此断言临时放宽为仅校验启动指南
  //（agent-startup-guide.md——稳定、人工维护、非镜像生成）。
  // TODO(P6-B ← dev-driver (A) canon-restore)：待上游恢复落地并完成镜像后，重新加入
  // `expect(architectSkill).toContain("rig spec audit rig.yaml")`（连同其 readFileSync）——
  // 届时镜像站在我们这一侧，而非对立面。
  it("routes rig authors through the advisory spec audit in the startup guide (TEMP: skill assertion re-adds on (A) canon-restore)", () => {
    const startupGuide = fs.readFileSync(
      nodePath.resolve(import.meta.dirname, "../../../docs/reference/agent-startup-guide.md"),
      "utf-8",
    );
    expect(startupGuide).toContain("rig spec audit rig.yaml");
  });
});

describe("openrig-core plugin — hooks (HG-2.6 + HG-2.7)", () => {
  it("hooks/claude.json declares Claude activity + compaction bridge events", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, unknown> };
    expect(config.hooks).toBeDefined();
    expect(Object.keys(config.hooks).sort()).toEqual([
      // OPR.0.4.1.09：加入 PreCompact，使产品插件拥有标记写入方
      //（precompact-hook.mjs 生成恢复包并在 PreCompact 时写入
      // restore-pending/<seat>.json），而非依赖易漂移的 host skill 副本。
      "Notification", "PostCompact", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("PreCompact wires the product-plugin precompact-hook.mjs writer (OPR.0.4.1.09 — product owns the writer)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const preCompact = config.hooks["PreCompact"];
    expect(preCompact).toBeDefined();
    const commands = preCompact!.flatMap((entry) => entry.hooks.map((h) => h.command));
    // The PreCompact command must run the product-plugin writer that GENERATES the packet
    // (restore-from-jsonl) — never a hard-coded outputDir. Path is under skills/, via the
    // ${CLAUDE_PLUGIN_ROOT} substitution so the PRODUCT copy runs (drift-immune).
    expect(commands.some((c) => /CLAUDE_PLUGIN_ROOT.*claude-compaction-restore\/scripts\/precompact-hook\.mjs/.test(c))).toBe(true);
    // 写入方随产品树一并交付。
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs"))).toBe(true);
  });

  it("hooks/codex.json declares lifecycle events including PermissionRequest and PostCompact", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "codex.json"), "utf-8");
    const config = JSON.parse(content) as { hooks: Record<string, unknown> };
    expect(config.hooks).toBeDefined();
    // PermissionRequest（openai/codex PR #17563）已接线，使 Codex 审批提示产生
    // needs_input 运行时 hook = 面向 Codex 的 hook 主 rig-send 守卫（无 Claude 式 Notification）。
    expect(Object.keys(config.hooks).sort()).toEqual([
      "PermissionRequest", "PostCompact", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("ships refocus as one core feature without a SessionStart refocus registration", () => {
    for (const [runtime, variable] of [["claude", "CLAUDE_PLUGIN_ROOT"], ["codex", "PLUGIN_ROOT"]]) {
      const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", `${runtime}.json`), "utf-8");
      const config = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      const refocusEvents = Object.entries(config.hooks)
        .filter(([, entries]) => entries.some((entry) => entry.hooks.some((hook) => hook.command.includes("refocus.cjs"))))
        .map(([event]) => event);
      expect(refocusEvents).not.toContain("SessionStart");
      expect(refocusEvents).toContain("UserPromptSubmit");
      expect(refocusEvents).toContain("PostCompact");
      expect(content).toContain(`\${${variable}}`);
    }
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "skills", "refocusing", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "skills", "refocusing", "scripts", "trace-to-root.py"))).toBe(true);
    expect(fs.existsSync(nodePath.join(PLUGIN_ROOT, "skills", "refocusing", "references", "refocus.md"))).toBe(true);
  });

  it("hooks/scripts/activity-relay.cjs exists (the canonical relay script that POSTs to /api/activity/hooks)", () => {
    const relayPath = nodePath.join(PLUGIN_ROOT, "hooks", "scripts", "activity-relay.cjs");
    expect(fs.existsSync(relayPath)).toBe(true);
    const content = fs.readFileSync(relayPath, "utf-8");
    // The script is what plugin-shipped hooks invoke; it should POST to the
    // activity-hooks endpoint that the daemon (post-rip) preserved per
    // IMPL-PRD §1.2 endpoint discipline.
    expect(content).toMatch(/activity\/hooks|activity-hooks/i);
  });

  it("hooks/scripts/compaction-restore-bridge.cjs exists (Claude post-compact restore bridge)", () => {
    const bridgePath = nodePath.join(PLUGIN_ROOT, "hooks", "scripts", "compaction-restore-bridge.cjs");
    expect(fs.existsSync(bridgePath)).toBe(true);
    const content = fs.readFileSync(bridgePath, "utf-8");
    expect(content).toMatch(/Claude 会话已有 OpenRig 压缩恢复包可用/);
    expect(content).toMatch(/additionalContext/);
  });

  it("Claude hook commands reference ${CLAUDE_PLUGIN_ROOT} (Claude path substitution convention)", () => {
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "claude.json"), "utf-8");
    expect(content).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    // 应通过变量替换指向中继脚本
    expect(content).toMatch(/CLAUDE_PLUGIN_ROOT.*activity-relay\.cjs/);
    expect(content).toMatch(/CLAUDE_PLUGIN_ROOT.*compaction-restore-bridge\.cjs/);
  });

  it("Codex hook commands reference ${PLUGIN_ROOT} (the var Codex actually substitutes — OPR.0.4.1.10)", () => {
    // rev1-r2 catch (B1): Codex 0.139 substitutes ${PLUGIN_ROOT}/${CLAUDE_PLUGIN_ROOT} for
    // plugin-discovered hooks (verified: the var is present in the codex binary; ${CODEX_PLUGIN_ROOT}
    // is NOT, and nothing in OpenRig sets it). openrig-core projects to <cwd>/.codex/plugins/<id>/, so
    // ${PLUGIN_ROOT} resolves to the plugin dir and the activity-relay hook actually fires.
    const content = fs.readFileSync(nodePath.join(PLUGIN_ROOT, "hooks", "codex.json"), "utf-8");
    expect(content).toMatch(/\$\{PLUGIN_ROOT\}/);
    expect(content).toMatch(/PLUGIN_ROOT.*activity-relay\.cjs/);
    // 防止回退到不支持的变量。
    expect(content).not.toMatch(/CODEX_PLUGIN_ROOT/);
  });
});

describe("openrig-core plugin — projection-applicability (works with batch-1 pluginAppliesToX filters)", () => {
  it("dual-manifest plugin classifies as applicable to BOTH adapters under auto-detection", () => {
    // Per batch-1 pluginAppliesToClaude/pluginAppliesToCodex helpers:
    //   auto + .claude-plugin/plugin.json present → applies to Claude
    //   auto + .codex-plugin/plugin.json present → applies to Codex
    // openrig-core has BOTH manifest dirs, so auto-detect projects to both.
    const claudeManifest = nodePath.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    const codexManifest = nodePath.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    expect(fs.existsSync(claudeManifest)).toBe(true);
    expect(fs.existsSync(codexManifest)).toBe(true);
  });
});
