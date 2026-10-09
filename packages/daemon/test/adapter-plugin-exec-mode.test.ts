// OPR skills-vendoring exec-mode QA blocker（candidate 4c6d8883）：CWD plugin projection 丢失
// executable mode——真实 default-profile materialization 将 0755 helper script（例如
// claude-compaction-restore/scripts/*.mjs）写成 0644，因为两个 adapter 都通过 text
// readFile -> writeFile（writeFileSync utf-8）投影，使用 process 默认 mode 创建 dest file，
// 且不重新应用 source mode。
//
// 这些 REAL-fs pin（真实 0755 exec helper + 相邻 0644 non-exec 文件）覆盖 production 在
// startup.ts 接入的同一 fsOps shape，以及 statMode/chmod 对。它们同时覆盖 fresh-write 路径与
// content-identical idempotence-skip 路径（QA repro 会重新 materialize 已存在的 tree，因此即使
// content 逐字相同且跳过写入，也必须 reconcile mode）。

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: async () => true, sendKeys: async () => undefined,
    capturePaneContent: async () => "", getPaneCommand: async () => "",
    listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: async () => undefined,
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

// 镜像 startup.ts 的 real-fs ops，并增加 statMode/chmod（保留 mode 的 primitive）。
function realFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    listFiles: (dir: string) => {
      const r: string[] = [];
      const walk = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      walk(dir, "");
      return r;
    },
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, mode: number) => fs.chmodSync(p, mode),
  };
}

function makeBinding(cwd: string): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePlan(absolutePath: string): ProjectionPlan {
  const entry: ProjectionEntry = {
    category: "plugin", effectiveId: "openrig-core", sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec", resourcePath: absolutePath, absolutePath,
    classification: "safe_projection",
  };
  return { runtime: "claude-code", cwd: "/cwd", entries: [entry], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

// 构建真实 plugin source tree：可执行 nested helper（0755）+ 相邻 non-exec 文件（0644）。
function seedPluginTree(root: string) {
  const skillDir = nodePath.join(root, "openrig-core", "skills", "compaction-restore");
  fs.mkdirSync(nodePath.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "openrig-core", ".claude-plugin"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "openrig-core", ".codex-plugin"), { recursive: true });
  fs.writeFileSync(nodePath.join(root, "openrig-core", ".claude-plugin", "plugin.json"), "{}");
  fs.writeFileSync(nodePath.join(root, "openrig-core", ".codex-plugin", "plugin.json"), "{}");
  const hook = nodePath.join(skillDir, "scripts", "precompact-hook.mjs");
  const skillMd = nodePath.join(skillDir, "SKILL.md");
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

function perm(p: string): number { return fs.statSync(p).mode & 0o777; }

describe("CWD plugin projection 保留 executable mode（skills-vendoring QA blocker）", () => {
  it("Claude：nested exec helper 保持 0755，non-exec 相邻文件保持 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-claude-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as ClaudeAdapterFsOps });

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    const outHook = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.hookRel);
    const outSkill = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("Codex：nested exec helper 保持 0755，non-exec 相邻文件保持 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-codex-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as CodexAdapterFsOps });

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    const outHook = nodePath.join(cwd, ".codex/plugins/openrig-core", rel.hookRel);
    const outSkill = nodePath.join(cwd, ".codex/plugins/openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("Claude：即使 content 逐字相同，重新 projection 也会 reconcile mode（idempotence-skip 路径）", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "execmode-claude-idem-"));
    const src = nodePath.join(base, "src");
    const rel = seedPluginTree(src);
    const cwd = nodePath.join(base, "cwd");
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFsOps() as unknown as ClaudeAdapterFsOps });

    // 预置 content 逐字相同但 mode 错误（0644）的 projected helper——准确复现 QA state。
    const outHook = nodePath.join(cwd, ".claude/plugins/openrig-core", rel.hookRel);
    fs.mkdirSync(nodePath.dirname(outHook), { recursive: true });
    fs.copyFileSync(nodePath.join(src, "openrig-core", rel.hookRel), outHook);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    await adapter.project(makePlan(nodePath.join(src, "openrig-core")), makeBinding(cwd));

    // content 未变化（跳过写入），但 mode 必须 reconcile 为 source 的 0755。
    expect(perm(outHook)).toBe(0o755);
  });
});
