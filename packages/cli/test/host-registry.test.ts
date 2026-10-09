import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostRegistry,
  resolveHost,
  validateHostRegistry,
  defaultHostRegistryPath,
} from "../src/host-registry.js";

function withTempFile(name: string, contents: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "openrig-host-registry-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("host registry — defaultHostRegistryPath", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns ~/.openrig/hosts.yaml under the canonical OpenRig home", () => {
    vi.stubEnv("OPENRIG_HOME", "");
    vi.stubEnv("RIGGED_HOME", "");
    expect(defaultHostRegistryPath()).toBe(join(homedir(), ".openrig", "hosts.yaml"));
  });

  it("uses a configured OpenRig home without requiring a .openrig directory name", () => {
    const customHome = join(tmpdir(), "custom-rig-home");
    vi.stubEnv("OPENRIG_HOME", customHome);
    expect(defaultHostRegistryPath()).toBe(join(customHome, "hosts.yaml"));
  });
});

describe("host registry — loadHostRegistry", () => {
  it("loads a valid single-host registry", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-claude-test
    transport: ssh
    target: vm-claude-test.local
    user: tester
    notes: "Tart VM"
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.registry.hosts).toHaveLength(1);
        expect(r.registry.hosts[0]).toEqual({
          id: "vm-claude-test",
          transport: "ssh",
          target: "vm-claude-test.local",
          user: "tester",
          notes: "Tart VM",
        });
      }
    });
  });

  it("loads a valid multi-host registry with optional fields omitted", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-a
    transport: ssh
    target: vm-a.local
  - id: laptop-b
    transport: ssh
    target: laptop-b.tail-scale-net
    user: tester
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.registry.hosts.map((h) => h.id)).toEqual(["vm-a", "laptop-b"]);
        expect(r.registry.hosts[0]?.user).toBeUndefined();
        expect(r.registry.hosts[1]?.user).toBe("tester");
      }
    });
  });

  it("returns a clear error when the registry file is missing", () => {
    const r = loadHostRegistry("/tmp/openrig-non-existent-hosts.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("未找到主机注册表");
      expect(r.error).toContain("transport: ssh");
    }
  });

  it("rejects non-array hosts field", () => {
    withTempFile("hosts.yaml", `hosts: "not-an-array"\n`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("'hosts' 必须是数组");
    });
  });

  it("rejects entry missing required id", () => {
    withTempFile("hosts.yaml", `
hosts:
  - transport: ssh
    target: x.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("id：必需的非空字符串");
    });
  });

  it("rejects entry missing required target", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("target：必需的非空字符串");
    });
  });

  it("rejects non-ssh transport with v0-scope message", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: tailscale
    target: x.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("必须是");
        expect(r.error).toContain('"tailscale"');
      }
    });
  });

  it("rejects duplicate host ids", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
    target: x.local
  - id: vm-x
    transport: ssh
    target: y.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("重复的主机 id 'vm-x'");
    });
  });

  it("rejects empty user field", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
    target: x.local
    user: ""
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("user：可选，但如果存在必须是非空字符串");
    });
  });

  it("rejects malformed YAML with a clear error", () => {
    withTempFile("hosts.yaml", `hosts:\n  - id: vm-x\n  transport: ssh\n  target: x.local\nnot-valid: [`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("解析") && expect(r.error).toContain("主机注册表 YAML");
    });
  });

  it("rejects top-level non-object YAML", () => {
    const result = validateHostRegistry("just-a-string", "/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("必须是带 'hosts' 数组的 YAML 对象");
  });
});

describe("host registry — resolveHost", () => {
  const registry = {
    hosts: [
      { id: "vm-a", transport: "ssh" as const, target: "vm-a.local" },
      { id: "vm-b", transport: "ssh" as const, target: "vm-b.local", user: "ops" },
    ],
  };

  it("resolves a known id", () => {
    const r = resolveHost(registry, "vm-b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host.target).toBe("vm-b.local");
  });

  it("rejects an unknown id with the supported-list hint", () => {
    const r = resolveHost(registry, "vm-unknown");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("未知主机 id 'vm-unknown'");
      expect(r.error).toContain("vm-a");
      expect(r.error).toContain("vm-b");
    }
  });

  it("indicates an empty registry honestly", () => {
    const r = resolveHost({ hosts: [] }, "vm-x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("注册表为空");
  });
});
