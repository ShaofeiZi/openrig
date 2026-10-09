// Agent Starter v1 垂直 M1 resolver 的 Tier 1 证明：
// AgentStarterResolver 类 + AgentStarterCredentialScanFailedError。
// 按 slice IMPL § File: agent-starter-resolver.ts，no-credentials 扫描失败时 resolver 必须抛错；
// 它不会返回一个可被 orchestrator 忽略的“结果”。

import { describe, it, expect } from "vitest";
import {
  AgentStarterResolver,
  AgentStarterCredentialScanFailedError,
} from "../src/domain/agent-starter-resolver.js";

function makeFs(files: Record<string, string>) {
  const exists = (p: string) => Object.prototype.hasOwnProperty.call(files, p);
  const readFile = (p: string) => {
    if (!exists(p)) throw new Error(`ENOENT: ${p}`);
    return files[p]!;
  };
  return { exists, readFile };
}

const CLEAN_ENTRY = `draft: false
starter_id: fixture-clean
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

describe("AgentStarterResolver（M1）", () => {
  // === 查询链 ===

  it("registry 根：opts.registryRoot 优先于 env、home 和 fallback", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      registryRoot: "/explicit/root",
      env: { OPENRIG_AGENT_STARTER_ROOT: "/env/root", HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/explicit/root");
  });

  it("registry 根：opts.registryRoot 缺失时 env 变量优先", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { OPENRIG_AGENT_STARTER_ROOT: "/env/root", HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/env/root");
  });

  it("registry 根：registryRoot 与 env 缺失且 home 目录存在时 homeDirRoot 优先", () => {
    const fs = makeFs({ "/home/test/.openrig/agent-starters": "dir" });
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/home/test/.openrig/agent-starters");
  });

  it("registry 根：registryRoot 与 env 缺失且 home 目录不存在时使用配置的 fallback", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      fallbackRoot: "/fallback/root",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/fallback/root");
  });

  it("registry 根：home 目录缺失时默认回退到可移植 home 路径", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({
      env: { HOME: "/home/test" },
      homeDirRoot: "/home/test/.openrig/agent-starters",
      ...fs,
    });
    expect(resolver.getRegistryRoot()).toBe("/home/test/.openrig/agent-starters");
  });

  // === 成功解析 ===

  it("干净条目解析为一个以 registryRoot 为根的 ResolvedStartupFile", () => {
    const fs = makeFs({ "/registry/fixture-clean.yaml": CLEAN_ENTRY });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    const result = resolver.resolveStarter("fixture-clean");
    expect(result.registryPath).toBe("/registry/fixture-clean.yaml");
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("fixture-clean.yaml");
    expect(file.absolutePath).toBe("/registry/fixture-clean.yaml");
    expect(file.ownerRoot).toBe("/registry");
    expect(file.appliesOn).toEqual(["fresh_start"]);
    expect(file.required).toBe(true);
  });

  // === 凭证扫描拒绝：抛错而非返回 ===

  it("匹配凭证路径时抛出 AgentStarterCredentialScanFailedError", () => {
    const malicious = CLEAN_ENTRY.replace(
      "ready_check_evidence: ../evidence/fixture.md",
      "ready_check_evidence: ~/.claude/.credentials.json",
    );
    const fs = makeFs({ "/registry/fixture-mal.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toContain("credential_path_disallowed");
    // R2-3 脱敏：错误消息不得回显匹配行内容。
    expect(caught!.reason).toContain("内容已隐去");
    expect(caught!.reason).not.toContain(".credentials.json");
    expect(caught!.message).not.toContain(".credentials.json");
  });

  it("匹配凭证内容（api_key）时抛出 AgentStarterCredentialScanFailedError", () => {
    const malicious = `${CLEAN_ENTRY}api_key: example-not-real
`;
    const fs = makeFs({ "/registry/fixture-mal2.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal2");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.starterName).toBe("fixture-mal2");
    expect(caught!.reason).toContain("credential_content_disallowed");
    // R2-3 脱敏：错误不得包含 fixture 中的 secret 字符串。
    expect(caught!.reason).toContain("内容已隐去");
    expect(caught!.reason).not.toContain("example-not-real");
    expect(caught!.message).not.toContain("example-not-real");
    expect(caught!.reason).not.toContain("api_key");
    expect(caught!.message).not.toContain("api_key");
  });

  it("匹配不区分大小写的凭证标记（大写 API_KEY）时抛错", () => {
    const malicious = `${CLEAN_ENTRY}API_KEY: uppercase-not-real
`;
    const fs = makeFs({ "/registry/fixture-mal3.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal3");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    // R2-3 脱敏：大写标记同样不得泄漏。
    expect(caught!.reason).toContain("内容已隐去");
    expect(caught!.reason).not.toContain("API_KEY");
    expect(caught!.message).not.toContain("API_KEY");
    expect(caught!.reason).not.toContain("uppercase-not-real");
    expect(caught!.message).not.toContain("uppercase-not-real");
  });

  // R2-3 泄漏负向检查：token 形 secret 不得出现在错误消息中。
  it("从错误消息中脱敏 sk- token 形 fixture（R2-3）", () => {
    const malicious = CLEAN_ENTRY.replace(
      'value: "fixture-native-id"',
      'value: "sk-fakefakefakefakefakefakefakefake"',
    );
    const fs = makeFs({ "/registry/fixture-mal-token.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal-token");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toContain("credential_content_disallowed");
    expect(caught!.reason).toContain("内容已隐去");
    // token 形子串不得出现在任一字段中。
    expect(caught!.reason).not.toContain("sk-fakefakefakefakefakefakefakefake");
    expect(caught!.message).not.toContain("sk-fakefakefakefakefakefakefakefake");
  });

  // R2-3 诊断保留：拒绝 code、行号与文件路径仍必须出现，供操作者排查。
  it("错误消息保留非敏感诊断（拒绝 code、行号与路径）", () => {
    const malicious = `${CLEAN_ENTRY}api_key: example
`;
    const fs = makeFs({ "/registry/fixture-mal-diag.yaml": malicious });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    let caught: AgentStarterCredentialScanFailedError | undefined;
    try {
      resolver.resolveStarter("fixture-mal-diag");
    } catch (err) {
      if (err instanceof AgentStarterCredentialScanFailedError) caught = err;
      else throw err;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toMatch(/credential_content_disallowed/);
    expect(caught!.reason).toMatch(/第 \d+ 行/);
    expect(caught!.reason).toContain("/registry/fixture-mal-diag.yaml");
  });

  it("allowlist 例外：接受 ~/.claude/projects/ 下的 transcript_path", () => {
    const withTranscript = `${CLEAN_ENTRY}transcript_path: /Users/x/.claude/projects/fixture/abc.jsonl
`;
    const fs = makeFs({ "/registry/fixture-allow.yaml": withTranscript });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    const result = resolver.resolveStarter("fixture-allow");
    expect(result.files).toHaveLength(1);
  });

  // === 条目缺失 / YAML 格式错误 ===

  it("registry 条目缺失时抛错", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("nonexistent"))
      .toThrow(/未找到注册表条目/);
  });

  it("YAML 格式错误（缺少 starter_id 字段）时抛错", () => {
    const fs = makeFs({ "/registry/fixture-bad.yaml": "this is not a starter entry\n" });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("fixture-bad"))
      .toThrow(/不符合注册表条目结构/);
  });

  it("文件为空时抛错", () => {
    const fs = makeFs({ "/registry/fixture-empty.yaml": "" });
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("fixture-empty"))
      .toThrow(/为空或不可读/);
  });

  // === 名称形状校验（路径遍历守卫）===

  it("名称含路径遍历字符时抛错", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("../etc/passwd"))
      .toThrow(/名称.*无效/);
  });

  it("名称含斜杠时抛错", () => {
    const fs = makeFs({});
    const resolver = new AgentStarterResolver({ registryRoot: "/registry", ...fs });
    expect(() => resolver.resolveStarter("foo/bar"))
      .toThrow(/名称.*无效/);
  });
});
