// PL-016——manifest 解析器测试。

import { describe, it, expect } from "vitest";
import { parseAgentImageManifest } from "../src/domain/agent-images/manifest-parser.js";
import { AgentImageError } from "../src/domain/agent-images/agent-image-types.js";

const validManifest = `
name: driver-release-primed
version: 1
runtime: claude-code
source_seat: velocity-driver@openrig-velocity
source_session_id: abc-123
source_resume_token: tok-xyz
created_at: "2026-05-04T19:00:00Z"
notes: |
  Snapshot after 2-hour PL-005 review session.
estimated_tokens: 80000
files:
  - path: cwd-delta.md
    role: cwd-delta
    summary: cwd-deltas at snapshot time
lineage:
  - velocity-driver-base
`;

describe("parseAgentImageManifest", () => {
  it("将有效 manifest 解析为带类型的结构", () => {
    const m = parseAgentImageManifest(validManifest, "/test/manifest.yaml");
    expect(m.name).toBe("driver-release-primed");
    expect(m.version).toBe("1");
    expect(m.runtime).toBe("claude-code");
    expect(m.sourceSeat).toBe("velocity-driver@openrig-velocity");
    expect(m.sourceSessionId).toBe("abc-123");
    expect(m.sourceResumeToken).toBe("tok-xyz");
    expect(m.notes).toContain("PL-005 review");
    expect(m.estimatedTokens).toBe(80000);
    expect(m.lineage).toEqual(["velocity-driver-base"]);
    expect(m.files).toHaveLength(1);
  });

  it("将数字版本规范化为字符串", () => {
    const m = parseAgentImageManifest(`
name: x
version: 2
runtime: codex
source_seat: x@y
source_session_id: s
source_resume_token: t
files: []
`, "/x.yaml");
    expect(m.version).toBe("2");
  });

  it("拒绝非 YAML 内容", () => {
    expect(() => parseAgentImageManifest("{not valid", "/x.yaml")).toThrow(AgentImageError);
    try { parseAgentImageManifest("{not valid", "/x.yaml"); } catch (err) {
      expect((err as AgentImageError).code).toBe("manifest_parse_error");
    }
  });

  it("拒绝缺少 name 的 manifest", () => {
    expect(() => parseAgentImageManifest("version: 1\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/name/);
  });

  it("拒绝缺少 version 的 manifest", () => {
    expect(() => parseAgentImageManifest("name: x\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/version/);
  });

  it("拒绝无效的 runtime", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: bash\nsource_seat: x\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/runtime/);
  });

  it("拒绝缺少 source_seat 的 manifest", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: claude-code\nsource_session_id: s\nsource_resume_token: t\nfiles: []", "/x.yaml")).toThrow(/source_seat/);
  });

  it("拒绝缺少 source_resume_token 的 manifest", () => {
    expect(() => parseAgentImageManifest("name: x\nversion: 1\nruntime: claude-code\nsource_seat: x\nsource_session_id: s\nfiles: []", "/x.yaml")).toThrow(/source_resume_token/);
  });

  it("拒绝路径中含有 .. 的文件", () => {
    expect(() => parseAgentImageManifest(`
name: x
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files:
  - path: ../escape.md
    role: r
`, "/x.yaml")).toThrow(/镜像内的相对路径/);
  });

  it("拒绝使用不受支持后缀的文件", () => {
    expect(() => parseAgentImageManifest(`
name: x
version: 1
runtime: claude-code
source_seat: x
source_session_id: s
source_resume_token: t
files:
  - path: code.ts
    role: r
`, "/x.yaml")).toThrow(/不支持的后缀/);
  });

  it("同时接受 camelCase 和 snake_case manifest key", () => {
    const camelManifest = `
name: x
version: 1
runtime: claude-code
sourceSeat: x@y
sourceSessionId: s
sourceResumeToken: t
files: []
`;
    const m = parseAgentImageManifest(camelManifest, "/x.yaml");
    expect(m.sourceSeat).toBe("x@y");
    expect(m.sourceSessionId).toBe("s");
    expect(m.sourceResumeToken).toBe("t");
  });
});
