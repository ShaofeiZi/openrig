import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateHostRegistry,
  resolveRemoteBearer,
  classifyHttpFailedStep,
  classifyHttpError,
  type HttpHostEntry,
} from "../src/host-registry.js";

describe("host-registry HTTP 传输验证", () => {
  it("接受带 bearer_env 的有效 http 条目", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "HOST_B_TOKEN" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.registry.hosts[0]!.transport).toBe("http");
      expect((r.registry.hosts[0] as HttpHostEntry).url).toBe("http://192.168.64.97:7433");
    }
  });

  it("接受带 bearer_file 的有效 http 条目", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_file: "/tmp/token" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
  });

  it("接受不带 bearer 来源的 http 条目（匿名/无 token 后台服务）", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const h = r.registry.hosts[0] as HttpHostEntry;
      expect(h.bearer_env).toBeUndefined();
      expect(h.bearer_file).toBeUndefined();
    }
  });

  it("拒绝同时包含两种 bearer 来源的 http 条目", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "TOK", bearer_file: "/tmp/tok" }],
    }, "test.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不要两者都指定");
  });

  it("拒绝 url 为空的 http 条目", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "", bearer_env: "TOK" }],
    }, "test.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("url");
  });

  it("ssh 条目仍可正常验证", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "vm", transport: "ssh", target: "vm.local" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
  });

  it("混合的 ssh 与 http 主机均能通过验证", () => {
    const r = validateHostRegistry({
      hosts: [
        { id: "vm", transport: "ssh", target: "vm.local" },
        { id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "TOK" },
      ],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.registry.hosts).toHaveLength(2);
  });
});

describe("resolveRemoteBearer", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("设置 bearer_env 时从中解析 token", () => {
    vi.stubEnv("HOST_B_TOKEN", "secret-token-123");
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe("secret-token-123");
  });

  it("环境变量未设置时返回 permission-gate", () => {
    delete process.env.MISSING_VAR;
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "MISSING_VAR" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failedStep).toBe("permission-gate");
      expect(r.error).not.toContain("secret");
    }
  });

  it("未配置来源时返回匿名成功（无 token）", () => {
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBeUndefined();
  });

  it("错误输出中不出现 token", () => {
    vi.stubEnv("HOST_B_TOKEN", "");
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain("secret");
    }
  });
});

describe("classifyHttpFailedStep", () => {
  it("200 => none", () => expect(classifyHttpFailedStep(200)).toBe("none"));
  it("201 => none", () => expect(classifyHttpFailedStep(201)).toBe("none"));
  it("401 => permission-gate", () => expect(classifyHttpFailedStep(401)).toBe("permission-gate"));
  it("403 => permission-gate", () => expect(classifyHttpFailedStep(403)).toBe("permission-gate"));
  it("404 => remote-command-failed", () => expect(classifyHttpFailedStep(404)).toBe("remote-command-failed"));
  it("500 => remote-command-failed", () => expect(classifyHttpFailedStep(500)).toBe("remote-command-failed"));
  it("0（连接错误）=> remote-daemon-unreachable", () => expect(classifyHttpFailedStep(0)).toBe("remote-daemon-unreachable"));
});

describe("电磁铁", () => {
  it("任意错误 => remote-daemon-unreachable", () => {
    expect(classifyHttpError(new Error("ECONNREFUSED"))).toBe("remote-daemon-unreachable");
  });
});
