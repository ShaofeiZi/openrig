// PL-016——library service 测试。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentImageLibraryService,
  agentImageId,
  parseAgentImageId,
  estimateTokensFromBytes,
} from "../src/domain/agent-images/agent-image-library-service.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";

function writeImage(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("AgentImageLibraryService", () => {
  let tmp: string;
  let userRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-image-lib-"));
    userRoot = join(tmp, "user");
    workspaceRoot = join(tmp, "workspace");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("扫描 image 并生成规范化 entry", () => {
    writeImage(userRoot, "smoke", `
name: smoke
version: 1
runtime: claude-code
source_seat: x@y
source_session_id: sid
source_resume_token: tok
files: []
`, {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(1);
    expect(result.errors).toEqual([]);
    const entries = lib.list();
    expect(entries[0]!.id).toBe(agentImageId("smoke", "1"));
    expect(entries[0]!.runtime).toBe("claude-code");
    expect(entries[0]!.sourceResumeToken).toBe("tok");
    expect(entries[0]!.stats.forkCount).toBe(0);
    expect(entries[0]!.pinned).toBe(false);
  });

  it("捕获解析错误，而不是让错误从 scan 抛出", () => {
    writeImage(userRoot, "broken", "{not valid yaml", {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("manifest_parse_error");
  });

  it("recordConsumption 增加 fork count 并更新 lastUsedAt", () => {
    writeImage(userRoot, "p", `
name: p
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`, {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const before = lib.list()[0]!;
    expect(before.stats.forkCount).toBe(0);

    lib.recordConsumption(before.id, () => new Date("2026-05-04T20:00:00Z"));
    const after = lib.list()[0]!;
    expect(after.stats.forkCount).toBe(1);
    expect(after.stats.lastUsedAt).toBe("2026-05-04T20:00:00.000Z");

    // 用新值重写 stats.json。
    const statsPath = join(after.sourcePath, "stats.json");
    expect(existsSync(statsPath)).toBe(true);
    const stats = JSON.parse(readFileSync(statsPath, "utf-8"));
    expect(stats.forkCount).toBe(1);
  });

  it("incrementForkCount: false 时 recordConsumption 只更新 lastUsedAt", () => {
    writeImage(userRoot, "p", `
name: p
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`, {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const before = lib.list()[0]!;
    expect(before.stats.forkCount).toBe(0);

    // 启动前乐观调用——更新 lastUsedAt，但不虚增 fork_count（lastUsedAt 记录意图，不受结果影响）。
    lib.recordConsumption(before.id, {
      incrementForkCount: false,
      now: () => new Date("2026-05-04T20:00:00Z"),
    });
    const afterIntent = lib.list()[0]!;
    expect(afterIntent.stats.forkCount).toBe(0);
    expect(afterIntent.stats.lastUsedAt).toBe("2026-05-04T20:00:00.000Z");

    // 启动成功后的调用——增加 fork_count。
    lib.recordConsumption(before.id, {
      incrementForkCount: true,
      now: () => new Date("2026-05-04T20:00:05Z"),
    });
    const afterSuccess = lib.list()[0]!;
    expect(afterSuccess.stats.forkCount).toBe(1);
    expect(afterSuccess.stats.lastUsedAt).toBe("2026-05-04T20:00:05.000Z");
  });

  it("recordConsumption 向后兼容：旧版位置 `now` 形式仍有效", () => {
    writeImage(userRoot, "p", `
name: p
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`, {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const before = lib.list()[0]!;
    // 旧版形式：位置 `() => Date` 参数视为时钟，incrementForkCount 默认为 true（为树外调用方
    // 保留首个已发布签名）。
    lib.recordConsumption(before.id, () => new Date("2026-05-04T20:00:00Z"));
    const after = lib.list()[0]!;
    expect(after.stats.forkCount).toBe(1);
    expect(after.stats.lastUsedAt).toBe("2026-05-04T20:00:00.000Z");
  });

  it("pin / unpin 写入和删除 .pinned sentinel", () => {
    writeImage(userRoot, "p", `
name: p
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`, {});
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const id = lib.list()[0]!.id;
    lib.pin(id);
    expect(existsSync(join(userRoot, "p", ".pinned"))).toBe(true);
    expect(lib.list()[0]!.pinned).toBe(true);
    lib.unpin(id);
    expect(existsSync(join(userRoot, "p", ".pinned"))).toBe(false);
    expect(lib.list()[0]!.pinned).toBe(false);
  });

  it("install 写入 manifest、stats 和补充文件", () => {
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const manifest: AgentImageManifest = {
      name: "installed",
      version: "1",
      runtime: "claude-code",
      sourceSeat: "x@y",
      sourceSessionId: "sid",
      sourceResumeToken: "tok",
      createdAt: "2026-05-04T19:00:00Z",
      notes: "Installed via install()",
      files: [{ path: "supplement.md", role: "notes" }],
    };
    const fileContents = new Map<string, string>([["supplement.md", "supplementary content"]]);
    const targetDir = lib.install(userRoot, manifest, fileContents);
    expect(existsSync(join(targetDir, "manifest.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "stats.json"))).toBe(true);
    expect(readFileSync(join(targetDir, "supplement.md"), "utf-8")).toBe("supplementary content");
    // 重新扫描会发现新 entry。
    lib.scan();
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0]!.name).toBe("installed");
  });

  it("install 拒绝重复名称", () => {
    const lib = new AgentImageLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const manifest: AgentImageManifest = {
      name: "dup", version: "1", runtime: "claude-code",
      sourceSeat: "x", sourceSessionId: "s", sourceResumeToken: "t",
      createdAt: "2026-01-01T00:00:00Z", files: [],
    };
    lib.install(userRoot, manifest, new Map());
    expect(() => lib.install(userRoot, manifest, new Map())).toThrow(/已存在/);
  });

  it("发生冲突时 workspace root 优先（位于 roots 数组最后）", () => {
    const sameManifest = `
name: collision
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files: []
`;
    writeImage(userRoot, "collision", sameManifest, {});
    writeImage(workspaceRoot, "collision", sameManifest, {});
    const lib = new AgentImageLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });
    lib.scan();
    expect(lib.list()[0]!.sourceType).toBe("workspace");
  });
});

describe("agentImageId / parseAgentImageId", () => {
  it("编码和解码 name:version", () => {
    expect(agentImageId("foo", "1")).toBe("agent-image:foo:1");
    expect(parseAgentImageId("agent-image:foo:1")).toEqual({ name: "foo", version: "1" });
  });

  it("在最后一个冒号处分割，使含冒号名称可往返", () => {
    const id = agentImageId("project:alpha", "3");
    expect(parseAgentImageId(id)).toEqual({ name: "project:alpha", version: "3" });
  });

  it("对非 agent-image id 返回 null", () => {
    expect(parseAgentImageId("context-pack:foo:1")).toBeNull();
    expect(parseAgentImageId("workflow:foo:1")).toBeNull();
  });
});

describe("estimateTokensFromBytes", () => {
  it("使用字符数/4 启发式", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(7)).toBe(2);
    expect(estimateTokensFromBytes(100)).toBe(25);
  });
});
