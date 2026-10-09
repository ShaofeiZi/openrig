// OPR.0.5.3.5 Atom 4b——PROFILE 路由：基于 library + tree source 的 situation-composed
// delivery（mini-req 1/3/5/7 在后台服务 surface 产品化）。
// GET /library/by-ref/profile?ref=&situation=&runtime=[&budget=][&rig=&seat=]
// 通过唯一 parser chokepoint 解析 pack atom，构建 fail-loud 多 source readFile（library = pack
// dir；seat: = 从 topology.root 配置解析的 topology tree 席位目录，即
// rigs/<rig>/seats/<seat>，slice-06 D1 layout），为每个 piece 标记来源并返回组合后的 profile。
// 每次 compose 失败都呈现具名 4xx 错误，绝不退化成内容缩水的 walk。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

const MANIFEST = `
name: world-install
version: "1"
taxonomy: world
files:
  - { path: walk.md, role: world }
atoms:
  - id: welcome
    address: "walk.md#welcome"
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
  - id: recap
    address: "seat:RECAP.md#recent-decisions"
    taxonomy: lore
    situations: [handover, post-compaction]
    purpose: width
    order: 9
    priority: core
`;

describe("GET /library/by-ref/profile——situation-composed delivery（Atom 4b）", () => {
  let tmp: string;
  let libRoot: string;
  let app: Hono;
  const savedTopologyRoot = process.env["OPENRIG_TOPOLOGY_ROOT"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s05-profile-route-"));
    libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "packs", "world");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), MANIFEST);
    writeFileSync(join(packDir, "walk.md"), "## Welcome\nhello world");
    // slice-06 D1 定义的 seat tree：<topology.root>/rigs/<rig>/seats/<seat>/。
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, "RECAP.md"), "## Recent Decisions\nwe chose X because Y");
    process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
    const lib = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    lib.scan();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedTopologyRoot === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopologyRoot;
  });

  const url = (qs: string) => `/api/context-packs/library/by-ref/profile?ref=${encodeURIComponent("packs/world")}&${qs}`;

  it("组合 HANDOVER，其中 recap 位于 SEAT-TREE 并按地址组装，source label 可见", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual(["welcome", "recap"]);
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.sourceKind).toBe("seat");
    expect(recap.text).toContain("we chose X because Y");
    expect(body.pieces.find((p) => p.atomId === "welcome")!.sourceKind).toBe("library");
  });

  it("每个 piece 携带 sha256，使 profile 与 walk 可按精确 hash 比较（Test-A door gate）", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ text: string; sha256: string }> };
    const { createHash } = await import("node:crypto");
    for (const p of body.pieces) {
      expect(p.sha256).toBe(createHash("sha256").update(p.text, "utf8").digest("hex"));
    }
  });

  it("FRESH 不使用 seat tree 也可组合；未选择 tree atom 时无需 rig/seat 参数", async () => {
    const res = await app.request(url("situation=fresh&runtime=claude"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual(["welcome"]);
  });

  it("tree atom 缺少 rig/seat 参数时明确失败并点名缺失配置，绝不返回缩水 walk", async () => {
    const res = await app.request(url("situation=handover&runtime=claude"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/seat/i);
    expect(body.message).toMatch(/根|配置|rig/i);
  });

  it("报告 budget 超限和 drop candidate，不截断任何内容", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1&budget=1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: unknown[]; budget?: { overageTokens: number; dropCandidates: unknown[] } };
    expect(body.pieces).toHaveLength(2);
    expect(body.budget).toBeDefined();
    expect(body.budget!.overageTokens).toBeGreaterThan(0);
  });

  it("r1 RIDER 1：每个 piece 携带字节 provenance；报告 symlink read，label 不谎报字节来源", async () => {
    // r1 对 4a 的 live probe：seat root 内 symlink 返回 root 外 secret，但 source label 仍为
    // 'seat'；它对 REF 正确，对 BYTE 错误。Q2-Amendment 1 绑定逐 piece source label；provenance
    // 必须跟随字节。只报告、不阻塞，因为 realpath containment 会破坏产品自身合法 symlink 布局。
    const { symlinkSync, realpathSync } = await import("node:fs");
    const outside = join(tmp, "outside-secret.md");
    writeFileSync(outside, "## Recent Decisions\nSECRET BYTES");
    // macOS /var 本身是指向 /private/var 的 symlink；与真实路径比较，也就是 provenance surface
    // 报告的路径。
    const outsideReal = realpathSync(outside);
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    rmSync(join(seatDir, "RECAP.md"));
    symlinkSync(outside, join(seatDir, "RECAP.md"));
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pieces: Array<{ atomId: string; provenance: { nominalPath: string; realPath: string; escapesRoot: boolean } }>;
      provenanceWarnings: string[];
    };
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.provenance.realPath).toBe(outsideReal);
    expect(recap.provenance.escapesRoot).toBe(true);
    expect(body.provenanceWarnings.some((w) => w.includes("recap"))).toBe(true);
    // 真实 piece 保持安静：没有 warning 点名 'welcome'，其真实路径位于 pack 内。
    const welcome = body.pieces.find((p) => p.atomId === "welcome")!;
    expect(welcome.provenance.escapesRoot).toBe(false);
    expect(body.provenanceWarnings.some((w) => w.includes("welcome"))).toBe(false);
  });

  it("r1 RIDER 2：没有显式 rig/seat grant 时，不可信 pack 的 seat: atom 不读取任何内容；grant 仅限具名席位", async () => {
    // Slice-07 R4 从 URL 安装 pack，恶意 manifest 可能携带 seat:/mission: atom。ingest 按设计
    // 透传它们；trust boundary 是 compose 调用，rig/seat 参数是调用方对那个席位目录读权限的
    // 显式 grant。无参数就不读取（上方已固定为 missing-config 422）；grant 绝不超出具名席位。
    // 本 pin 端到端固定 GRANT SEMANTICS：相同 pack、相同 atom；无 grant = 422 并点名缺失
    // root，有 grant = 发生读取且在 provenance surface 可见。
    const denied = await app.request(url("situation=handover&runtime=claude"));
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { message: string }).message).toMatch(/seat/i);
    const granted = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(granted.status).toBe(200);
    const body = await granted.json() as { pieces: Array<{ atomId: string; provenance: { realPath: string } }> };
    expect(body.pieces.find((p) => p.atomId === "recap")!.provenance.realPath).toContain(join("rigs", "r1", "seats", "s1"));
  });

  it("r1 F1（round 3）：root 内名为 '..hidden-notes.md' 的文件不被标记；比较 segment，不按路径字符串 prefix 匹配", async () => {
    // r1 实测结构：relative() 返回 '..hidden-notes.md'，裸 startsWith('..') 把它当成 escape；
    // 这与 startsWith(base) 是同一 bug 类别，只是向内复现一层。trust surface 若对无辜文件误报，
    // 会让读者习惯忽略它。
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    writeFileSync(join(seatDir, "..hidden-notes.md"), "## Recent Decisions\ninnocent bytes");
    const manifest2 = MANIFEST.replace("seat:RECAP.md#recent-decisions", "seat:..hidden-notes.md#recent-decisions");
    // 以 '..' 开头的文件名不是 '..' segment，parseSourceRef 必须一致。
    writeFileSync(join(libRoot, "packs", "world", "manifest.yaml"), manifest2);
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pieces: Array<{ atomId: string; provenance: { escapesRoot: boolean } }>;
      provenanceWarnings: string[];
    };
    expect(body.pieces.find((p) => p.atomId === "recap")!.provenance.escapesRoot).toBe(false);
    expect(body.provenanceWarnings).toEqual([]);
  });

  it("r1 pre-judgment（2）：DANGLING symlink 使用自身具名失败，绝不是乱码 provenance error", async () => {
    const { symlinkSync } = await import("node:fs");
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    rmSync(join(seatDir, "RECAP.md"));
    symlinkSync(join(tmp, "never-existed.md"), join(seatDir, "RECAP.md"));
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/悬空|符号链接/i);
    expect(body.message).toContain("RECAP.md");
  });

  it("r1 pre-judgment（minor）：provenanceWarnings 始终是数组；clean compose 时为空", async () => {
    const res = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { provenanceWarnings: string[] };
    expect(Array.isArray(body.provenanceWarnings)).toBe(true);
    expect(body.provenanceWarnings).toEqual([]);
  });

  it("Atom 4d：调用方点名任务目标时，mission: atom 从指定 workspace.slices_root key 解析；缺参仍明确 missing-config", async () => {
    // Desk 裁定（row 2675535d）：不要新增 config key；missions tree 已有 workspace.slices_root；
    // mission root = <slices_root>/<mission>。
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const missionDir = join(tmp, "missions", "release-x");
      mkdirSync(missionDir, { recursive: true });
      writeFileSync(join(missionDir, "NOTES.md"), "## Watch Items\nW-99 lives here");
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(tmp, "missions");
      const withMission = MANIFEST + `  - id: watch
    address: "mission:NOTES.md#watch-items"
    taxonomy: mission
    situations: [handover]
    purpose: width
    order: 50
    priority: recommended
`;
      writeFileSync(join(libRoot, "packs", "world", "manifest.yaml"), withMission);
      const granted = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1&mission=release-x"));
      expect(granted.status).toBe(200);
      const body = await granted.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
      const watch = body.pieces.find((p) => p.atomId === "watch")!;
      expect(watch.sourceKind).toBe("mission");
      expect(watch.text).toContain("W-99 lives here");
      // 没有 mission 参数：位于任务目标的 atom 明确失败，绝不返回缩水 walk。
      const denied = await app.request(url("situation=handover&runtime=claude&rig=r1&seat=s1"));
      expect(denied.status).toBe(422);
      expect(((await denied.json()) as { message: string }).message).toMatch(/mission/i);
    } finally {
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("Story 1：显式 legacy mission/slice 以默认 provenance 添加常规 project → mission → slice SPEC walk", async () => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      const missionDir = join(workspace, "missions", "release-x");
      const sliceDir = join(missionDir, "slices", "10-work-install");
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(workspace, "SPEC.md"), "# Project\nProject intent sentinel");
      writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission change sentinel");
      writeFileSync(join(sliceDir, "SPEC.md"), "# Slice\nExact outcome sentinel");
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      const res = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        pieces: Array<{
          atomId: string;
          address: string;
          sourceKind: string;
          altitude?: string;
          source?: string;
          text: string;
          provenance: { nominalPath: string };
        }>;
      };
      const work = body.pieces.filter((piece) => piece.source === "default");
      expect(work.map(({ altitude, address, sourceKind }) => ({ altitude, address, sourceKind }))).toEqual([
        { altitude: "project", address: "project:SPEC.md", sourceKind: "project" },
        { altitude: "mission", address: "mission:SPEC.md", sourceKind: "mission" },
        { altitude: "slice", address: "mission:slices/10-work-install/SPEC.md", sourceKind: "mission" },
      ]);
      expect(work.map((piece) => piece.text)).toEqual([
        "# Project\nProject intent sentinel",
        "# Mission\nMission change sentinel",
        "# Slice\nExact outcome sentinel",
      ]);
      expect(work.map((piece) => piece.provenance.nominalPath)).toEqual([
        join(workspace, "SPEC.md"),
        join(missionDir, "SPEC.md"),
        join(sliceDir, "SPEC.md"),
      ]);
      expect(body.pieces.at(-3)?.altitude).toBe("project");
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("Story 2：有效 project manifest 重新标记常规 intent，并按声明顺序追加 project context", async () => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      const missionDir = join(workspace, "missions", "release-x");
      const sliceDir = join(missionDir, "slices", "10-work-install");
      mkdirSync(join(workspace, "context"), { recursive: true });
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(workspace, "SPEC.md"), "# Project\nProject intent sentinel");
      writeFileSync(join(workspace, "context", "first.md"), "# First\nFirst authored context");
      writeFileSync(join(workspace, "context", "second.md"), "# Second\nSecond authored context");
      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context:
    - context/first.md
    - context/second.md
missions:
  root: missions
`);
      writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission change sentinel");
      writeFileSync(join(sliceDir, "SPEC.md"), "# Slice\nExact outcome sentinel");
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      const res = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        pieces: Array<{
          address: string;
          altitude?: string;
          source?: string;
          text: string;
          provenance: { nominalPath: string };
        }>;
      };
      const projectPieces = body.pieces.filter((piece) => piece.altitude === "project");
      expect(projectPieces.map(({ address, source }) => ({ address, source }))).toEqual([
        { address: "project:SPEC.md", source: "manifest" },
        { address: "project:context/first.md", source: "manifest" },
        { address: "project:context/second.md", source: "manifest" },
      ]);
      expect(body.pieces.filter((piece) => piece.altitude !== undefined).map((piece) => piece.address)).toEqual([
        "project:SPEC.md",
        "project:context/first.md",
        "project:context/second.md",
        "mission:SPEC.md",
        "mission:slices/10-work-install/SPEC.md",
      ]);
      expect(projectPieces.map((piece) => piece.text)).toEqual([
        "# Project\nProject intent sentinel",
        "# First\nFirst authored context",
        "# Second\nSecond authored context",
      ]);
      expect(body.pieces.filter((piece) => piece.address === "project:SPEC.md")).toHaveLength(1);
      expect(projectPieces.map((piece) => piece.provenance.nominalPath)).toEqual([
        join(workspace, "SPEC.md"),
        join(workspace, "context", "first.md"),
        join(workspace, "context", "second.md"),
      ]);
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("Story 2：有效 project manifest 替换常规 intent address", async () => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      const missionDir = join(workspace, "missions", "release-x");
      const sliceDir = join(missionDir, "slices", "10-work-install");
      mkdirSync(join(workspace, "context"), { recursive: true });
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(workspace, "SPEC.md"), "# Project\nConventional intent must not compose");
      writeFileSync(join(workspace, "context", "project-intent.md"), "# Project\nAuthored project intent");
      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
install:
  intent: context/project-intent.md
missions:
  root: missions
`);
      writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission change sentinel");
      writeFileSync(join(sliceDir, "SPEC.md"), "# Slice\nExact outcome sentinel");
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      const res = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        pieces: Array<{ address: string; altitude?: string; source?: string; text: string }>;
      };
      const projectPieces = body.pieces.filter((piece) => piece.altitude === "project");
      expect(projectPieces).toMatchObject([
        { address: "project:context/project-intent.md", source: "manifest", text: "# Project\nAuthored project intent" },
      ]);
      expect(body.pieces.some((piece) => piece.address === "project:SPEC.md")).toBe(false);
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it.each([
    { caseName: "wrong-type", intent: "42" },
    { caseName: "traversal-shaped", intent: "../outside.md" },
    { caseName: "malformed-fragment", intent: "\"SPEC.md#\"" },
  ])("Story 2: $caseName optional project intent warns and preserves the baseline install", async ({ intent }) => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      const missionDir = join(workspace, "missions", "release-x");
      const sliceDir = join(missionDir, "slices", "10-work-install");
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(workspace, "SPEC.md"), "# Project\nProject intent sentinel");
      writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission change sentinel");
      writeFileSync(join(sliceDir, "SPEC.md"), "# Slice\nExact outcome sentinel");
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
missions:
  root: missions
`);
      const baselineRes = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(baselineRes.status).toBe(200);
      const baseline = await baselineRes.json() as {
        pieces: Array<{ atomId: string; address: string; altitude?: string; source?: string; text: string; sha256: string }>;
      };

      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
install:
  intent: ${intent}
missions:
  root: missions
`);
      const invalidRes = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(invalidRes.status).toBe(200);
      const invalid = await invalidRes.json() as {
        pieces: Array<{ atomId: string; address: string; altitude?: string; source?: string; text: string; sha256: string }>;
        warnings?: string[];
        provenanceWarnings: string[];
      };
      const workShape = (pieces: typeof invalid.pieces) => pieces
        .filter((piece) => piece.altitude !== undefined)
        .map(({ atomId, address, altitude, source, text, sha256 }) => ({ atomId, address, altitude, source, text, sha256 }));
      expect(workShape(invalid.pieces)).toEqual(workShape(baseline.pieces));
      expect(invalid.warnings).toEqual([
        "project.yaml：可选 install.intent 必须是相对 Markdown 地址；已忽略该非法值并保留基线工作 install。",
      ]);
      expect(invalid.provenanceWarnings).toEqual([]);
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it.each([
    { caseName: "wrong-type", context: "not-a-list" },
    { caseName: "mixed-invalid", context: "\n    - context/first.md\n    - ../outside.md" },
    { caseName: "malformed-fragment", context: "\n    - context/first.md\n    - \"SPEC.md#a/b/c\"" },
  ])("Story 2: $caseName optional project context warns and preserves the baseline install", async ({ context }) => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      const missionDir = join(workspace, "missions", "release-x");
      const sliceDir = join(missionDir, "slices", "10-work-install");
      mkdirSync(join(workspace, "context"), { recursive: true });
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(workspace, "SPEC.md"), "# Project\nProject intent sentinel");
      writeFileSync(join(workspace, "context", "first.md"), "# First\nValid context must not compose from a mixed list");
      writeFileSync(join(missionDir, "SPEC.md"), "# Mission\nMission change sentinel");
      writeFileSync(join(sliceDir, "SPEC.md"), "# Slice\nExact outcome sentinel");
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
missions:
  root: missions
`);
      const baselineRes = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(baselineRes.status).toBe(200);
      const baseline = await baselineRes.json() as {
        pieces: Array<{ atomId: string; address: string; altitude?: string; source?: string; text: string; sha256: string }>;
      };

      writeFileSync(join(workspace, "project.yaml"), `schema: openrig.project/v0alpha1
kind: project
install:
  context: ${context}
missions:
  root: missions
`);
      const invalidRes = await app.request(url("situation=fresh&runtime=codex&mission=release-x&slice=10-work-install"));
      expect(invalidRes.status).toBe(200);
      const invalid = await invalidRes.json() as {
        pieces: Array<{ atomId: string; address: string; altitude?: string; source?: string; text: string; sha256: string }>;
        warnings?: string[];
        provenanceWarnings: string[];
      };
      const workShape = (pieces: typeof invalid.pieces) => pieces
        .filter((piece) => piece.altitude !== undefined)
        .map(({ atomId, address, altitude, source, text, sha256 }) => ({ atomId, address, altitude, source, text, sha256 }));
      expect(workShape(invalid.pieces)).toEqual(workShape(baseline.pieces));
      expect(invalid.warnings).toEqual([
        "project.yaml：可选 install.context 必须是相对 Markdown 地址列表；已忽略该非法值并保留基线工作 install。",
      ]);
      expect(invalid.provenanceWarnings).toEqual([]);
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("Story 1：没有准确 slice 的 legacy-default 请求明确拒绝，而不是接受 no-op mission grant", async () => {
    const savedWorkspace = process.env["OPENRIG_WORKSPACE_ROOT"];
    const savedSlices = process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    try {
      const workspace = join(tmp, "workspace");
      mkdirSync(join(workspace, "missions", "release-x"), { recursive: true });
      process.env["OPENRIG_WORKSPACE_ROOT"] = workspace;
      process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = join(workspace, "missions");

      const res = await app.request(url("situation=fresh&runtime=codex&mission=release-x"));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "slice_required" });
    } finally {
      if (savedWorkspace === undefined) delete process.env["OPENRIG_WORKSPACE_ROOT"];
      else process.env["OPENRIG_WORKSPACE_ROOT"] = savedWorkspace;
      if (savedSlices === undefined) delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
      else process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = savedSlices;
    }
  });

  it("错误输入产生具名 4xx：未知 situation、无 atom pack、未知 ref", async () => {
    const badSituation = await app.request(url("situation=someday&runtime=claude"));
    expect(badSituation.status).toBe(400);
    expect(((await badSituation.json()) as { message: string }).message).toMatch(/situation/);

    const noAtomsDir = join(libRoot, "packs", "bare");
    mkdirSync(noAtomsDir, { recursive: true });
    writeFileSync(join(noAtomsDir, "manifest.yaml"), 'name: bare\nversion: "1"\ntaxonomy: world\nfiles:\n  - { path: a.md, role: x }\n');
    writeFileSync(join(noAtomsDir, "a.md"), "## A\nbody");
    const lib2res = await app.request("/api/context-packs/library/by-ref/profile?ref=packs%2Fbare&situation=fresh&runtime=claude");
    // Library 必须重新 sync 才能看到它；路由自身会重新读取 manifest。
    expect([200, 404, 422]).toContain(lib2res.status);
    if (lib2res.status === 422) {
      expect(((await lib2res.json()) as { message: string }).message).toMatch(/atoms/);
    }

    const missing = await app.request("/api/context-packs/library/by-ref/profile?ref=packs%2Fghost&situation=fresh&runtime=claude");
    expect(missing.status).toBe(404);
  });
});

const SYNTHETIC_WORLD_MANIFEST = `
name: synthetic-world
version: "1"
taxonomy: world
files:
  - { path: world-from-primitives.md, role: world }
  - { path: permission-self-sleep.md, role: world }
  - { path: what-this-is-for.md, role: world }
  - { path: ontology.md, role: world }
  - { path: harness-power-use.md, role: world }
  - { path: a-competent-turn.md, role: world }
  - { path: what-you-can-do.md, role: reference }
  - { path: reference-material.md, role: reference }
atoms:
  - { id: world-from-primitives, address: world-from-primitives.md, taxonomy: world, situations: [fresh], purpose: depth, order: 1, priority: core }
  - { id: permission-self-sleep, address: permission-self-sleep.md, taxonomy: world, situations: [fresh], purpose: depth, order: 2, priority: core }
  - { id: what-this-is-for, address: what-this-is-for.md, taxonomy: world, situations: [fresh], purpose: depth, order: 3, priority: core }
  - { id: ontology, address: ontology.md, taxonomy: world, situations: [fresh, post-compaction], purpose: depth, order: 4, priority: core }
  - { id: harness-power-use, address: harness-power-use.md, taxonomy: world, situations: [fresh], purpose: depth, order: 5, priority: core }
  - { id: what-you-can-do, address: what-you-can-do.md, taxonomy: skills, situations: [post-compaction], purpose: width, order: 6, priority: core }
  - { id: reference-material, address: reference-material.md, taxonomy: lore, situations: [post-compaction], purpose: width, order: 7, priority: core }
  - { id: a-competent-turn, address: a-competent-turn.md, taxonomy: world, situations: [fresh, post-compaction], purpose: depth, order: 8, priority: core }
  - { id: recap, address: "seat:RECAP.md", taxonomy: lore, situations: [handover, post-compaction], purpose: width, order: 9, priority: core }
`;

describe("synthetic world graph——seat RECAP 通过真实路由组合", () => {
  let tmp: string;
  let app: Hono;
  const savedTopologyRoot = process.env["OPENRIG_TOPOLOGY_ROOT"];
  const SENTINEL = "sentinel-recap-7fce914a8: we chose the atoms graph because drift";
  const PACK_FILES = [
    "world-from-primitives.md",
    "permission-self-sleep.md",
    "what-this-is-for.md",
    "ontology.md",
    "harness-power-use.md",
    "a-competent-turn.md",
    "what-you-can-do.md",
    "reference-material.md",
  ];

  function buildApp(withRecap: boolean): void {
    tmp = mkdtempSync(join(tmpdir(), "s05-prod-recap-"));
    const libRoot = join(tmp, "lib");
    const packDir = join(libRoot, "world", "install");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "manifest.yaml"), SYNTHETIC_WORLD_MANIFEST);
    for (const file of PACK_FILES) {
      writeFileSync(join(packDir, file), `## Synthetic fixture\n${file}\n`);
    }
    if (withRecap) {
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      mkdirSync(seatDir, { recursive: true });
      writeFileSync(join(seatDir, "RECAP.md"), `## Decisions\n${SENTINEL}`);
    } else {
      mkdirSync(join(tmp, "topology", "rigs", "r1", "seats", "s1"), { recursive: true });
    }
    process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
    const lib = new ContextPackLibraryService({ roots: [{ path: libRoot, sourceType: "builtin" }] });
    lib.scan();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextPackLibrary" as never, lib);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
  }

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedTopologyRoot === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopologyRoot;
  });

  const profileUrl = (qs: string) => `/api/context-packs/library/by-ref/profile?ref=${encodeURIComponent("world/install")}&${qs}`;

  it("HANDOVER = fresh walk + seat-sourced RECAP，并保留 sentinel byte 与 sourceKind seat", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string; text: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "world-from-primitives", "permission-self-sleep", "what-this-is-for", "ontology", "harness-power-use", "a-competent-turn", "recap",
    ]);
    const recap = body.pieces.find((p) => p.atomId === "recap")!;
    expect(recap.sourceKind).toBe("seat");
    expect(recap.text).toContain("sentinel-recap-7fce914a8");
  });

  it("POST-COMPACTION = 实测 re-prime + seat-sourced RECAP", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=post-compaction&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string; sourceKind: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "ontology", "what-you-can-do", "reference-material", "a-competent-turn", "recap",
    ]);
    expect(body.pieces.find((p) => p.atomId === "recap")!.sourceKind).toBe("seat");
  });

  it("缺少 seat RECAP 时以具名错误明确失败，绝不静默返回缩水 handover", async () => {
    buildApp(false);
    const res = await app.request(profileUrl("situation=handover&runtime=claude&rig=r1&seat=s1"));
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/recap/i);
  });

  it("FRESH 无需 seat tree，保持六 piece walk；recap 绝不泄漏进 fresh", async () => {
    buildApp(true);
    const res = await app.request(profileUrl("situation=fresh&runtime=claude"));
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ atomId: string }> };
    expect(body.pieces.map((p) => p.atomId)).toEqual([
      "world-from-primitives", "permission-self-sleep", "what-this-is-for", "ontology", "harness-power-use", "a-competent-turn",
    ]);
  });
});
