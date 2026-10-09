// Slice 28 Checkpoint C-3——skill-library API 测试。
//
// SC-29 异常 #11 累积（逐字声明见
// packages/daemon/src/routes/plugins.ts header).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLibraryDiscoveryService } from "../src/domain/skill-library-discovery.js";
import { skillsRoutes } from "../src/routes/skills.js";

interface TestEnv {
  root: string;
  sharedSkillsDir: string;
  workspaceRoot: string;
  service: SkillLibraryDiscoveryService;
}

function setup(opts: { withWorkspace?: boolean } = {}): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "skill-library-routes-"));
  const sharedSkillsDir = join(root, "openrig-shared-skills");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(sharedSkillsDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const allowlist = opts.withWorkspace
    ? [{ name: "workspace", canonicalPath: workspaceRoot }]
    : [];
  const service = new SkillLibraryDiscoveryService({
    sharedSkillsDir,
    filesAllowlist: allowlist,
  });
  return { root, sharedSkillsDir, workspaceRoot, service };
}

function createApp(service: SkillLibraryDiscoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("skillLibraryDiscoveryService" as never, service);
    await next();
  });
  app.route("/api/skills", skillsRoutes());
  return app;
}

function makeSkill(baseDir: string, relativePath: string, files: Array<{ name: string; content: string }>): string {
  const skillDir = join(baseDir, relativePath);
  mkdirSync(skillDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(skillDir, f.name), f.content);
  }
  return skillDir;
}

describe("SkillLibraryDiscoveryService——发现（slice 28 HG-5 修复）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("flat openrig-managed：发现 shared-skills root 下的 skill", () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("openrig-managed:claude-compact-in-place");
    expect(skills[0]?.name).toBe("claude-compact-in-place");
    expect(skills[0]?.source).toBe("openrig-managed");
    expect(skills[0]?.files.map((f) => f.name)).toEqual(["SKILL.md"]);
  });

  it("HG-5 ROOT CAUSE FIX：发现 nested openrig-managed skill（category/skill/SKILL.md）", () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-architect", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "pm/requirements-writer", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills.map((s) => s.id).sort()).toEqual([
      "openrig-managed:core/openrig-architect",
      "openrig-managed:core/openrig-user",
      "openrig-managed:pm/requirements-writer",
    ]);
  });

  it("混合 layout：在同一 shared root 发现 flat + nested skill", () => {
    makeSkill(env.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toContain("openrig-managed:claude-compact-in-place");
    expect(ids).toContain("openrig-managed:core/openrig-user");
    // category folder name 本身不应出现。
    expect(ids).not.toContain("openrig-managed:core");
  });

  it("DEPTH-CAP：不发现 depth-3+ skill（MAX_NESTING_DEPTH=1）", () => {
    makeSkill(env.sharedSkillsDir, "outer/inner/deep-skill", [{ name: "SKILL.md", content: "# body" }]);
    const skills = env.service.listLibrarySkills();
    expect(skills).toHaveLength(0);
  });

  it("workspace source：在 allowlist root 下发现 .openrig/skills/<name>", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.id).toBe("workspace:workspace:operator-skill");
      expect(skills[0]?.source).toBe("workspace");
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("CONSOLIDATION：一次调用同时呈现 workspace + openrig-managed", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      makeSkill(envWith.sharedSkillsDir, "claude-compact-in-place", [{ name: "SKILL.md", content: "# body" }]);
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      const sources = skills.map((s) => s.source).sort();
      expect(sources).toEqual(["openrig-managed", "workspace"]);
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("shared-skills directory 缺失：只返回 workspace", () => {
    const envWith = setup({ withWorkspace: true });
    try {
      // 清空 shared-skills directory；service 不得抛错。
      rmSync(envWith.sharedSkillsDir, { recursive: true, force: true });
      makeSkill(envWith.workspaceRoot, ".openrig/skills/operator-skill", [{ name: "SKILL.md", content: "# body" }]);
      const skills = envWith.service.listLibrarySkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.source).toBe("workspace");
    } finally {
      rmSync(envWith.root, { recursive: true, force: true });
    }
  });

  it("listLibrarySkillsPublic：包含 absolutePath（slice 29 HG-4 file-path discoverability）", () => {
    makeSkill(env.sharedSkillsDir, "alpha-skill", [{ name: "SKILL.md", content: "# body" }]);
    const pub = env.service.listLibrarySkillsPublic();
    expect(pub).toHaveLength(1);
    expect("absolutePath" in (pub[0] ?? {})).toBe(true);
    expect(pub[0]?.absolutePath).toContain("alpha-skill");
  });
});

describe("GET /api/skills/library（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("返回 consolidated skill list，并呈现 absolutePath（slice 29 HG-4）", async () => {
    makeSkill(env.sharedSkillsDir, "alpha-skill", [{ name: "SKILL.md", content: "# top" }]);
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# nested" }]);
    const res = await createApp(env.service).request("/api/skills/library");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; source: string; absolutePath: string }>;
    const ids = body.map((s) => s.id).sort();
    expect(ids).toEqual([
      "openrig-managed:alpha-skill",
      "openrig-managed:core/openrig-user",
    ]);
    // Slice 29 HG-4：public response 现在呈现 absolutePath，使 skill detail 页面可向 operator
    // 显示每个 skill 在磁盘上的位置。
    expect("absolutePath" in (body[0] ?? {})).toBe(true);
    expect(body.every((s) => typeof s.absolutePath === "string" && s.absolutePath.length > 0)).toBe(true);
  });

  it("context 未提供 service 时返回 503", async () => {
    const app = new Hono();
    app.use("*", async (_c, next) => { await next(); });
    app.route("/api/skills", skillsRoutes());
    const res = await app.request("/api/skills/library");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("skill_library_unavailable");
  });
});

describe("GET /api/skills/:id/files/list（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("列出 skill root 的 file + directory（path=''）", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [
      { name: "SKILL.md", content: "# body" },
      { name: "config.json", content: "{}" },
      { name: "fixture.yaml", content: "k: v" },
    ]);
    // 添加 subfolder，验证 list 会呈现它。
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skillId: string; entries: Array<{ name: string; type: string }> };
    expect(body.skillId).toBe(id);
    const names = body.entries.map((e) => e.name);
    // 呈现所有文件（HG-7 spec：不限于 Markdown）。
    expect(names).toContain("SKILL.md");
    expect(names).toContain("config.json");
    expect(names).toContain("fixture.yaml");
    expect(names).toContain("examples");
    // directory 排在文件前。
    expect(names.indexOf("examples")).toBeLessThan(names.indexOf("SKILL.md"));
  });

  it("HG-8 列出 nested directory 内容（path='examples'）", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic");
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/advanced.md"), "# advanced");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=examples`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("basic.md");
    expect(names).toContain("advanced.md");
  });

  it("skill id 未知时返回 404", async () => {
    const res = await createApp(env.service).request("/api/skills/missing-skill/files/list?path=");
    expect(res.status).toBe(404);
  });

  it("以 400 path_escape 拒绝 '..' escape attempt", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=..%2Fsomewhere`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });

  it("拒绝 symlink escape（realpath 位于 skill folder 外）", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const escapeTarget = join(env.root, "outside-target");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "secret.txt"), "out-of-bounds");
    symlinkSync(escapeTarget, join(env.sharedSkillsDir, "core/openrig-user/escape-link"));
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/list?path=escape-link`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("GET /api/skills/:id/files/read（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("从 nested skill 读取 SKILL.md content", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# OpenRig User skill body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=SKILL.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skillId: string; path: string; content: string; contentHash: string };
    expect(body.skillId).toBe(id);
    expect(body.path).toBe("SKILL.md");
    expect(body.content).toContain("OpenRig User skill body");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("HG-8 读取 nested-subfolder 文件（examples/basic.md）", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# root" }]);
    mkdirSync(join(env.sharedSkillsDir, "core/openrig-user/examples"), { recursive: true });
    writeFileSync(join(env.sharedSkillsDir, "core/openrig-user/examples/basic.md"), "# basic example");
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=examples%2Fbasic.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("basic example");
  });

  it("缺少 path query 时返回 400 path_required", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_required");
  });

  it("文件不存在时返回 404 stat_failed", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=nonexistent.md`);
    expect(res.status).toBe(404);
  });

  it("以 400 path_escape 拒绝 '..' escape attempt", async () => {
    makeSkill(env.sharedSkillsDir, "core/openrig-user", [{ name: "SKILL.md", content: "# body" }]);
    const id = "openrig-managed:core/openrig-user";
    const res = await createApp(env.service).request(`/api/skills/${encodeURIComponent(id)}/files/read?path=..%2Fsomewhere.md`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});
