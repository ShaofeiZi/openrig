// OPR.0.4.4.23——脚手架为每个 SliceTemplateKind 都生成 SDLC 约定段
//（Rev-2 穷尽契约）：不带 `## Intent` / `## Mini-requirements` /
// `## Proof contract` 的 slice，无论其模板种类，都未暴露唯一的作用域约定。
// 测试枚举导出的 kind 集合，故未来加入 SLICE_TEMPLATE_KINDS 的 kind
// 会在此失败，直到其模板带上这些段。
// 约定 SSOT：docs/reference/sdlc-conventions.md。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";

import { scopeCommand } from "../src/commands/scope.js";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";
import {
  renderCapabilityDeltaTemplate,
  renderSliceProofTemplate,
  renderSliceTemplate,
} from "../src/lib/scope/templates.js";
import { MISSION_TEMPLATE_KINDS, SLICE_TEMPLATE_KINDS } from "../src/lib/scope/types.js";
import { renderMissionTemplate } from "../src/lib/scope/templates.js";

const CONVENTION_SECTION_VARIANTS = [
  ["## 意图"],
  ["## 最小需求", "## 小型需求"],
  ["## 证明契约", "## 证据约定"],
] as const;
const SSOT_POINTER = "docs/reference/sdlc-conventions.md";

// aa922842——双上下文指针契约。
//
// 脚手架输出落在用户工作区，故面向安装：读者可能根本没有仓库。同一文档经三条
// 不同路径到达他们，但只有两条可以被指引：
//   repo 源      docs/reference/sdlc-conventions.md          —— 对 repo 读者正确
//   安装稳定版 $OPENRIG_HOME/reference/sdlc-conventions.md —— 对已安装 agent 正确
//                                                                  （默认 ~/.openrig/…）
//   打包内部    daemon/docs/reference/…                     —— 装配输入，绝不指引
//
// Two failure modes this guards, both of which look fine in a repo checkout:
//   1. teaching ONLY the repo path — an installed agent looks somewhere that does not exist;
//   2. teaching the DEFAULT home as the only path — wrong for any operator with a custom
//      OPENRIG_HOME (this rig runs one). Naming `$OPENRIG_HOME/...` is MANDATORY; mentioning
//      `~/.openrig/...` alongside it as the default is honest and explicitly allowed, so this
//      does NOT ban the default — requiring the env-aware pointer already covers the risk.
const INSTALLED_POINTER_ENV = "$OPENRIG_HOME/reference/sdlc-conventions.md";
const INTERNAL_PACKED_PATH = "daemon/docs/reference/";

const RENDER_OPTS = {
  id: "OPR.0.4.4.99",
  slice_number: "99",
  slug: "conventions-probe",
  mission: "release-0.4.4",
  title: "Conventions Probe",
  created_date: "2026-07-06",
};

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-conventions-"));
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(path.join(missionsRoot, "release-0.4.4"), { recursive: true });
  fs.writeFileSync(
    path.join(missionsRoot, "release-0.4.4", "README.md"),
    "---\nid: OPR.0.4.4\nstage: wip\n---\n# release-0.4.4\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(missionsRoot, "release-0.4.4", "mission.yaml"),
    "schema: openrig.mission/v0alpha1\nkind: mission\ncomposition:\n  mission_markdown:\n    spec: README.md\n  slices: []\n",
    "utf8",
  );
  return { root, missionsRoot };
}

async function run(args: string[], missionsRoot: string): Promise<{ exitCode: number; stdout: string }> {
  const stdoutBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(missionsRoot)]);
  } catch {
    // Commander/process.exit paths are captured above.
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join("") };
}

describe("OPR.0.4.4.23 convention scaffold — exhaustive over SliceTemplateKind", () => {
  it("every SliceTemplateKind template emits the three convention sections + the SSOT pointer", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      const specPath = path.join(mktemp(), "SPEC.md");
      fs.writeFileSync(specPath, rendered, "utf8");
      const frontmatter = readFrontmatter(specPath);
      fs.rmSync(path.dirname(specPath), { recursive: true, force: true });
      expect(frontmatter.intent, `template kind "${kind}" has no frontmatter intent`).toBe(RENDER_OPTS.title);
      expect(frontmatter.depends_on, `template kind "${kind}" has no sibling-ordering edge list`).toEqual([]);
      for (const variants of CONVENTION_SECTION_VARIANTS) {
        expect(
          variants.some((section) => rendered.includes(section)),
          `模板类型 "${kind}" 缺少约定章节 "${variants.join(" / ")}"`,
        ).toBe(true);
      }
      expect(rendered, `template kind "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `template kind "${kind}" is missing the mission-slice-sop skill pointer`).toContain("mission-slice-sop");
    }
  });

  // aa922842 — dual-context pointer discriminator. Scaffolded output is installed-facing.
  it("every slice template teaches BOTH contexts: the repo path AND the OPENRIG_HOME-aware installed path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      // Repo context retained — a repo reader must not be sent to an installed-only path.
      expect(rendered, `template kind "${kind}" dropped the repo-source pointer`).toContain(SSOT_POINTER);
      // Installed context added — without this an agent on an installed package is told to
      // read a path that does not exist on their machine.
      expect(
        rendered,
        `template kind "${kind}" never names the installed stable path; an installed agent cannot find the conventions doc from this scaffold`,
      ).toContain(INSTALLED_POINTER_ENV);
    }
  });

  it("no template leaks the internal packed path as if it were a user path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(
        rendered.includes(INTERNAL_PACKED_PATH),
        `template kind "${kind}" teaches the internal assembly path ${INTERNAL_PACKED_PATH} as if it were a user path`,
      ).toBe(false);
    }
  });

  it("the convention sections come FIRST — kind-specific body sits below them", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      const firstSectionIdx = rendered.indexOf("## ");
      expect(
        rendered.slice(firstSectionIdx).startsWith("## 意图"),
        `模板类型 "${kind}" 没有以 ## 意图 开始其章节`,
      ).toBe(true);
      const miniIdx = Math.max(rendered.indexOf("## 最小需求"), rendered.indexOf("## 小型需求"));
      const proofIdx = Math.max(rendered.indexOf("## 证明契约"), rendered.indexOf("## 证据约定"));
      expect(firstSectionIdx, `kind "${kind}" section order broken`).toBeLessThan(miniIdx);
      expect(miniIdx, `kind "${kind}" section order broken`).toBeLessThan(proofIdx);
    }
  });

  it("mission templates carry intent + depends_on frontmatter and the convention pointers", () => {
    for (const kind of MISSION_TEMPLATE_KINDS) {
      const rendered = renderMissionTemplate(kind, RENDER_OPTS);
      const specPath = path.join(mktemp(), "SPEC.md");
      fs.writeFileSync(specPath, rendered, "utf8");
      const frontmatter = readFrontmatter(specPath);
      fs.rmSync(path.dirname(specPath), { recursive: true, force: true });
      expect(frontmatter.intent, `mission template "${kind}" has no frontmatter intent`).toBe(RENDER_OPTS.title);
      expect(frontmatter.depends_on, `mission template "${kind}" has no sibling-ordering edge list`).toEqual([]);
      expect(rendered, `mission template "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `mission template "${kind}" is missing the mission-slice-sop pointer`).toContain("mission-slice-sop");
    }
  });
});

describe("scope create — the mode-neutral SPEC/NOTES convention lands on disk", () => {
  let substrate: { root: string; missionsRoot: string };

  beforeEach(() => { substrate = seedSubstrate(); });
  afterEach(() => { fs.rmSync(substrate.root, { recursive: true, force: true }); });

  it("scaffolds exactly SPEC.md + PROGRESS.md + PROOF.md + proof/ for each SliceTemplateKind", async () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const r = await run(
        ["slice", "create", "release-0.4.4", `probe-${kind}`, "--template", kind, "--intent", `Intent for ${kind}`, "--json"],
        substrate.missionsRoot,
      );
      expect(r.exitCode, `slice create failed for kind "${kind}"`).toBe(0);
      const slicePath = JSON.parse(r.stdout).slice.path as string;

      expect(fs.readdirSync(slicePath).sort()).toEqual(["PROGRESS.md", "PROOF.md", "SPEC.md", "proof", "slice.yaml"]);

      const specPath = path.join(slicePath, "SPEC.md");
      const readme = fs.readFileSync(specPath, "utf8");
      expect(readFrontmatter(specPath)).toMatchObject({ intent: `Intent for ${kind}`, depends_on: [] });
      for (const variants of CONVENTION_SECTION_VARIANTS) {
        expect(
          variants.some((section) => readme.includes(section)),
          `模板类型 "${kind}" 创建的 SPEC 缺少约定章节 "${variants.join(" / ")}"`,
        ).toBe(true);
      }

      expect(fs.statSync(path.join(slicePath, "proof")).isDirectory(), `kind "${kind}" did not scaffold proof/`).toBe(true);
      expect(fs.existsSync(path.join(slicePath, "PROOF.md")), `kind "${kind}" did not scaffold PROOF.md`).toBe(true);
      expect(fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8")).toContain("## 验收");
      expect(fs.readFileSync(path.join(slicePath, "PROOF.md"), "utf8")).toContain("SPEC.md");
      expect(parseYaml(fs.readFileSync(path.join(slicePath, "slice.yaml"), "utf8"))).toEqual({
        schema: "openrig.slice/v0alpha1",
        kind: "slice",
        composition: {
          mission: "../../mission.yaml",
          slice_markdown: { spec: "SPEC.md", progress: "PROGRESS.md", proof: "PROOF.md" },
        },
      });
    }
    const mission = parseYaml(fs.readFileSync(path.join(substrate.missionsRoot, "release-0.4.4", "mission.yaml"), "utf8"));
    expect(mission.composition.slices).toHaveLength(SLICE_TEMPLATE_KINDS.length);
    expect(mission.composition.slices.map((member: { order: number }) => member.order))
      .toEqual(SLICE_TEMPLATE_KINDS.map((_, index) => (index + 1) * 10));
  });

  it("scaffolds exactly intent-bearing SPEC.md + NOTES.md + PROGRESS.md + slices/ for each MissionTemplateKind", async () => {
    for (const kind of MISSION_TEMPLATE_KINDS) {
      const name = `probe-${kind}`;
      const r = await run(
        ["mission", "create", name, "--template", kind, "--intent", `Intent for ${kind}`, "--json"],
        substrate.missionsRoot,
      );
      expect(r.exitCode, `mission create failed for kind "${kind}"`).toBe(0);
      const missionPath = JSON.parse(r.stdout).mission.path as string;
      expect(fs.readdirSync(missionPath).sort()).toEqual(["NOTES.md", "PROGRESS.md", "SPEC.md", "mission.yaml", "slices"]);
      expect(readFrontmatter(path.join(missionPath, "SPEC.md"))).toMatchObject({
        intent: `Intent for ${kind}`,
        depends_on: [],
      });
      expect(parseYaml(fs.readFileSync(path.join(missionPath, "mission.yaml"), "utf8"))).toEqual({
        schema: "openrig.mission/v0alpha1",
        kind: "mission",
        composition: { mission_markdown: { spec: "SPEC.md" }, slices: [] },
      });
    }
  });
});

describe("release capability-delta scaffold and expiry advisory", () => {
  let substrate: { root: string; missionsRoot: string };

  beforeEach(() => { substrate = seedSubstrate(); });
  afterEach(() => { fs.rmSync(substrate.root, { recursive: true, force: true }); });

  const releaseOpts = {
    ...RENDER_OPTS,
    slug: "release-0.5.4",
    mission: "release-0.5.4",
    title: "0.5.4",
    release_version: "0.5.4",
  };

  it("renders the reviewed delta shape from the shipped template", () => {
    const rendered = renderCapabilityDeltaTemplate(releaseOpts);
    for (const required of [
      "capability_delta: capability-delta-v0.5.4",
      "binding_target:",
      "sha:",
      "dirty:",
      "audience:",
      "review_status:",
      "expiry:",
      "## 现在可以做什么（按情境索引）",
      "在以下情况使用",
      "## 已落地，但尚不可直接操作",
      "## 应停止做什么",
      "此前正确：",
      "现在错误：",
      "## 选择探针",
      "仅凭增量判定",
      "## 规范补丁",
      "已经存在——不要重复",
      SSOT_POINTER,
      INSTALLED_POINTER_ENV,
    ]) {
      expect(rendered, `capability-delta template is missing ${required}`).toContain(required);
    }
  });

  it("dry-runs the real 0.5.4 consumer through mission creation", async () => {
    const result = await run(
      ["mission", "create", "release-0.5.4", "--intent", "Honest 0.5.4 boundary", "--json"],
      substrate.missionsRoot,
    );
    expect(result.exitCode).toBe(0);
    const mission = JSON.parse(result.stdout).mission;
    const deltaPath = path.join(mission.path, "CAPABILITY-DELTA-v0.5.4.md");
    expect(mission.capabilityDeltaPath).toBe(deltaPath);
    expect(fs.existsSync(deltaPath)).toBe(true);
    expect(fs.readFileSync(deltaPath, "utf8")).toContain("capability-delta-v0.5.4");
  });

  it("flags only an exact completed expiry event and remains advisory", async () => {
    const created = await run(
      ["mission", "create", "release-0.5.4", "--json"],
      substrate.missionsRoot,
    );
    const missionPath = JSON.parse(created.stdout).mission.path as string;
    const deltaPath = path.join(missionPath, "CAPABILITY-DELTA-v0.5.4.md");
    const configured = fs.readFileSync(deltaPath, "utf8")
      .replace('canon_path: "<能力规范路径>"', "canon_path: capability-canon.md")
      .replace('successor_path: "<后继增量路径>"', "successor_path: CAPABILITY-DELTA-v0.5.5.md");
    fs.writeFileSync(deltaPath, configured, "utf8");
    fs.writeFileSync(
      path.join(missionPath, "capability-canon.md"),
      "# Capability canon\n\nAbsorbed: capability-delta-v0.5.40\n\n## Capabilities\n",
      "utf8",
    );

    const live = await run(["audit", "--mission", "release-0.5.4", "--json"], substrate.missionsRoot);
    expect(live.exitCode).toBe(0);
    expect(JSON.parse(live.stdout).mission.findings.map((finding: { kind: string }) => finding.kind))
      .not.toContain("expired_capability_delta");

    fs.writeFileSync(path.join(missionPath, "CAPABILITY-DELTA-v0.5.5.md"), "successor\n", "utf8");
    const nearMatch = await run(["audit", "--mission", "release-0.5.4", "--json"], substrate.missionsRoot);
    expect(nearMatch.exitCode).toBe(0);
    expect(JSON.parse(nearMatch.stdout).mission.findings.filter(
      (finding: { kind: string }) => finding.kind === "expired_capability_delta",
    )).toHaveLength(0);

    const canonPath = path.join(missionPath, "capability-canon.md");
    fs.rmSync(canonPath);
    fs.mkdirSync(canonPath);
    const unreadable = await run(["audit", "--mission", "release-0.5.4", "--json"], substrate.missionsRoot);
    expect(unreadable.exitCode).toBe(0);
    expect(JSON.parse(unreadable.stdout).mission.findings.filter(
      (finding: { kind: string }) => finding.kind === "expired_capability_delta",
    )).toHaveLength(0);

    fs.rmSync(canonPath, { recursive: true });
    fs.writeFileSync(
      canonPath,
      "# Capability canon\n\nAbsorbed: capability-delta-v0.5.4\n\n## Capabilities\n",
      "utf8",
    );
    const expired = await run(["audit", "--mission", "release-0.5.4", "--json"], substrate.missionsRoot);
    const parsed = JSON.parse(expired.stdout);
    expect(expired.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    const expiryFindings = parsed.mission.findings.filter(
      (finding: { kind: string }) => finding.kind === "expired_capability_delta",
    );
    expect(expiryFindings).toHaveLength(1);
    expect(expiryFindings[0]).toEqual(expect.objectContaining({
      kind: "expired_capability_delta",
      severity: "medium",
      message: expect.stringMatching(/canon 头部.*后继文件.*不再可被引用/),
    }));
  });
});

describe("scope mission graph — depends_on is an advisory sibling-ordering edge", () => {
  let substrate: { root: string; missionsRoot: string };

  beforeEach(() => {
    substrate = seedSubstrate();
    const missionPath = path.join(substrate.missionsRoot, "release-0.4.4");
    fs.writeFileSync(path.join(missionPath, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionPath, "NOTES.md"), "# Notes\n", "utf8");
    const writeSlice = (
      bucket: "slices" | "closed",
      name: string,
      id: string,
      dependsOn: string[] | string,
      status?: string,
    ) => {
      const slicePath = path.join(missionPath, bucket, name);
      fs.mkdirSync(slicePath, { recursive: true });
      fs.writeFileSync(path.join(slicePath, "SPEC.md"), [
        "---",
        `id: ${id}`,
        `intent: ${name}`,
        ...(status ? [`status: ${status}`] : []),
        `depends_on: ${Array.isArray(dependsOn) ? `[${dependsOn.join(", ")}]` : dependsOn}`,
        "---",
        `# ${name}`,
      ].join("\n"), "utf8");
      if (bucket === "slices") fs.writeFileSync(path.join(slicePath, "PROGRESS.md"), "# Progress\n", "utf8");
    };
    writeSlice("closed", "01-foundation", "OPR.0.4.4.1", []);
    writeSlice("slices", "02-ready", "OPR.0.4.4.2", ["OPR.0.4.4.1"]);
    writeSlice("slices", "03-waiting", "OPR.0.4.4.3", ["OPR.0.4.4.4"]);
    writeSlice("slices", "04-active-dependency", "OPR.0.4.4.4", []);
    writeSlice("slices", "05-stale-edge", "OPR.0.4.4.5", ["OPR.0.4.4.999", "OPR.0.5.0.1"]);
    writeSlice("slices", "06-malformed-edge", "OPR.0.4.4.6", "not-a-list");
    writeSlice("slices", "07-done-dependency", "OPR.0.4.4.7", [], "done");
    writeSlice("slices", "08-after-done", "OPR.0.4.4.8", ["OPR.0.4.4.7"]);
  });
  afterEach(() => { fs.rmSync(substrate.root, { recursive: true, force: true }); });

  it("returns a deterministic ready set, ignores stale/cross-parent edges with advisories, and leaves absent edges compatible", async () => {
    const r = await run(["mission", "graph", "release-0.4.4", "--json"], substrate.missionsRoot);
    expect(r.exitCode).toBe(0);
    const graph = JSON.parse(r.stdout).graph;
    expect(graph.ready).toEqual(["OPR.0.4.4.2", "OPR.0.4.4.4", "OPR.0.4.4.5", "OPR.0.4.4.6", "OPR.0.4.4.8"]);
    expect(graph.waiting).toEqual([{ id: "OPR.0.4.4.3", on: ["OPR.0.4.4.4"] }]);
    expect(graph.nodes.map((node: { id: string }) => node.id)).not.toContain("OPR.0.4.4.7");
    expect(graph.advisories).toEqual([
      expect.objectContaining({ id: "OPR.0.4.4.5", dependency: "OPR.0.4.4.999", kind: "missing_sibling" }),
      expect.objectContaining({ id: "OPR.0.4.4.5", dependency: "OPR.0.5.0.1", kind: "outside_parent" }),
      expect.objectContaining({ id: "OPR.0.4.4.6", kind: "invalid_field" }),
    ]);
  });

  it("scope audit exposes the exact graph reader result, including malformed-edge advisories", async () => {
    const graphResult = await run(["mission", "graph", "release-0.4.4", "--json"], substrate.missionsRoot);
    const auditResult = await run(["audit", "--mission", "release-0.4.4", "--json"], substrate.missionsRoot);
    expect(auditResult.exitCode).toBe(0);
    expect(JSON.parse(auditResult.stdout).graph).toEqual(JSON.parse(graphResult.stdout).graph);
  });
});

// OPR.0.4.4.23 PM-acceptance fixback — the shipped teaching surfaces must
// LEAD a naive agent to the C1 drop verb: every scaffolded artifact that
// mentions proving names `rig proof add` and `--media` explicitly (the
// naive-agent rerun showed generic "rig proof drops" prose produced manual
// proof-dir curation and no C1 drops).
describe("OPR.0.4.4.23 teaching surfaces name the drop verb", () => {
  it("every slice template's proving guidance names rig proof add and --media", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(rendered, `模板类型 "${kind}" 未提及 zrig proof add`).toContain("zrig proof add");
      expect(rendered, `template kind "${kind}" does not name --media`).toContain("--media");
    }
  });

  it("the PROOF.md template names rig proof add and --media and binds to SPEC.md", () => {
    const proof = renderSliceProofTemplate({ id: RENDER_OPTS.id, title: RENDER_OPTS.title });
    expect(proof).toContain("zrig proof add");
    expect(proof).toContain("--media");
    expect(proof).toContain("SPEC.md");
    expect(proof).toContain("只手工放入文件而不执行 drop");
  });
});
