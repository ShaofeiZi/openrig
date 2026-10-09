import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  AuthBearerTokenStartupError,
  assertBindAuthInvariant,
  authBearerTokenMiddleware,
  constantTimeEqual,
  isLoopbackBind,
  isTailscaleBind,
  resolveToIpOrNull,
  findTailscaleIpInInterfaces,
} from "../src/middleware/auth-bearer-token.js";
import type { NetworkInterfaceInfo } from "node:os";

describe("auth-bearer-token 中间件（PL-005 阶段 B）", () => {
  it("constantTimeEqual 对相同字符串返回 true", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("constantTimeEqual 对长度相同但内容不同的字符串返回 false", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("constantTimeEqual 对长度不同的字符串返回 false", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("isLoopbackBind 能识别回环主机名", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("127.42.7.99")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("[::1]")).toBe(true);
  });

  it("isLoopbackBind 将非回环主机判定为非回环", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("100.64.0.5")).toBe(false);
    expect(isLoopbackBind("10.0.0.1")).toBe(false);
    expect(isLoopbackBind("rig.local")).toBe(false);
  });

  it("isLoopbackBind 将空值或 undefined 判定为非回环（安全默认值）", () => {
    expect(isLoopbackBind("")).toBe(false);
    expect(isLoopbackBind(undefined)).toBe(false);
    expect(isLoopbackBind(null)).toBe(false);
  });

  // 硬门禁审计第 8 行（现根据 auth-bearer-tailscale-trust 分片改为异步）。
  // 注意：新模型现在将 100.64.0.5 视为 tailscale（CGNAT）；公网 IP 场景（0.0.0.0）仍会抛错。
  it("硬门禁：真正的公网绑定使用空 bearer 时，assertBindAuthInvariant 抛错", async () => {
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: null }),
    ).rejects.toThrow(AuthBearerTokenStartupError);
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "" }),
    ).rejects.toThrow(AuthBearerTokenStartupError);
  });

  it("硬门禁：回环绑定即使 bearer 为空，assertBindAuthInvariant 也通过", async () => {
    await expect(
      assertBindAuthInvariant({ host: "127.0.0.1", bearerToken: null }),
    ).resolves.toBeUndefined();
    await expect(
      assertBindAuthInvariant({ host: "localhost", bearerToken: "" }),
    ).resolves.toBeUndefined();
  });

  it("硬门禁：非回环绑定具有非空 bearer 时，assertBindAuthInvariant 通过", async () => {
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "secret" }),
    ).resolves.toBeUndefined();
    await expect(
      assertBindAuthInvariant({ host: "192.168.1.5", bearerToken: "secret" }),
    ).resolves.toBeUndefined();
  });

  // ==================================================================
  // 缺陷修复分片：auth-bearer-tailscale-trust（2026-05-11）
  // ==================================================================

  describe("isTailscaleBind (CGNAT IPv4 + ULA IPv6)", () => {
    it("匹配 CGNAT IPv4 100.64.0.0/10——第二个八位组包含 64..127", () => {
      expect(isTailscaleBind("100.64.0.0")).toBe(true);
      expect(isTailscaleBind("100.64.0.5")).toBe(true);
      expect(isTailscaleBind("100.95.124.51")).toBe(true);
      expect(isTailscaleBind("100.127.255.255")).toBe(true);
    });

    it("拒绝 CGNAT 范围外的 IPv4（HG-3 边界）", () => {
      // 下界之外：100.63.x.x 不在 100.64.0.0/10 中
      expect(isTailscaleBind("100.63.255.255")).toBe(false);
      // 上界之外：100.128.x.x 不在 100.64.0.0/10 中
      expect(isTailscaleBind("100.128.0.0")).toBe(false);
      // 第一个八位组不匹配
      expect(isTailscaleBind("101.64.0.0")).toBe(false);
      expect(isTailscaleBind("99.64.0.0")).toBe(false);
    });

    it("拒绝无关 IPv4（局域网、公网、回环）", () => {
      expect(isTailscaleBind("127.0.0.1")).toBe(false);
      expect(isTailscaleBind("192.168.1.5")).toBe(false);
      expect(isTailscaleBind("10.0.0.1")).toBe(false);
      expect(isTailscaleBind("203.0.113.45")).toBe(false);
      expect(isTailscaleBind("0.0.0.0")).toBe(false);
    });

    it("匹配 tailscale ULA IPv6 前缀 fd7a:115c:a1e0::/48", () => {
      expect(isTailscaleBind("fd7a:115c:a1e0::1")).toBe(true);
      expect(isTailscaleBind("fd7a:115c:a1e0:ab12:3456:7890:abcd:ef01")).toBe(true);
      // 带方括号形式（URL 风格）
      expect(isTailscaleBind("[fd7a:115c:a1e0::1]")).toBe(true);
      // 不区分大小写
      expect(isTailscaleBind("FD7A:115C:A1E0::1")).toBe(true);
    });

    it("拒绝无关 IPv6（其他 ULA、公网、回环）", () => {
      expect(isTailscaleBind("fd00::1")).toBe(false);
      expect(isTailscaleBind("fd7b:115c:a1e0::1")).toBe(false); // off by one in first segment
      expect(isTailscaleBind("::1")).toBe(false);
      expect(isTailscaleBind("2001:db8::1")).toBe(false);
    });

    it("拒绝空值 / null / undefined / 主机名（由解析器路径处理）", () => {
      expect(isTailscaleBind("")).toBe(false);
      expect(isTailscaleBind(undefined)).toBe(false);
      expect(isTailscaleBind(null)).toBe(false);
      expect(isTailscaleBind("foo.example.com")).toBe(false);
      expect(isTailscaleBind("host.tail-scale-net.ts.net")).toBe(false);
    });
  });

  describe("resolveToIpOrNull", () => {
    it("将真实回环主机名解析为 IP", async () => {
      const ip = await resolveToIpOrNull("localhost");
      // 根据平台不同，localhost 解析为 127.0.0.1 或 ::1。
      expect(ip).toBeTruthy();
      expect(typeof ip).toBe("string");
    });

    it("对有意设置为无法解析的主机名返回 null（HG-4）", async () => {
      const ip = await resolveToIpOrNull("this-host-does-not-exist.invalid");
      expect(ip).toBeNull();
    });
  });

  describe("assertBindAuthInvariant——7 个 IMPL-PRD 场景", () => {
    // 场景 1：回环绑定，无 bearer → 通过
    it("(1) 回环绑定 127.0.0.1 且无 bearer → 通过", async () => {
      await expect(
        assertBindAuthInvariant({ host: "127.0.0.1", bearerToken: null }),
      ).resolves.toBeUndefined();
    });

    // 场景 2：Tailscale IPv4 绑定，无 bearer → 通过
    it("(2) tailscale IPv4 100.95.124.51 且无 bearer → 通过", async () => {
      await expect(
        assertBindAuthInvariant({ host: "100.95.124.51", bearerToken: null }),
      ).resolves.toBeUndefined();
    });

    // 场景 3：Tailscale magicDNS 主机名 → 通过（DNS 解析为 tailscale IP）
    it("(3) 解析为 tailscale IP 的 magicDNS 主机名 → 通过", async () => {
      const dns = await import("node:dns");
      const spy = vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "100.95.124.51", family: 4 } as unknown as never);
      try {
        await expect(
          assertBindAuthInvariant({ host: "host.tail-scale-net.ts.net", bearerToken: null }),
        ).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    // 场景 4：局域网绑定，无 bearer → 抛错
    it("(4) 局域网绑定 192.168.1.50 且无 bearer → 抛错", async () => {
      await expect(
        assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // 场景 5：0.0.0.0 绑定，无 bearer → 抛错
    it("(5) 通配地址 0.0.0.0 且无 bearer → 抛错", async () => {
      await expect(
        assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // 场景 6：公网 IP，无 bearer → 抛错
    it("(6) 公网 IP 203.0.113.45（TEST-NET-3）且无 bearer → 抛错", async () => {
      await expect(
        assertBindAuthInvariant({ host: "203.0.113.45", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // 场景 7：DNS 解析失败的主机名，无 bearer → 抛错
    it("(7) DNS 无法解析的主机名且无 bearer → 抛错（HG-4）", async () => {
      await expect(
        assertBindAuthInvariant({ host: "this-host-does-not-exist.invalid", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // 保留现有行为
    it("局域网绑定带 bearer → 通过（bearer 覆盖显式公网/局域网选择）", async () => {
      await expect(
        assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: "secret" }),
      ).resolves.toBeUndefined();
    });

    it("公网 IP 带 bearer → 通过", async () => {
      await expect(
        assertBindAuthInvariant({ host: "203.0.113.45", bearerToken: "secret" }),
      ).resolves.toBeUndefined();
    });

    it("错误消息列出全部 3 条可接受路径（HG-10）", async () => {
      try {
        await assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: null });
        expect.fail("应当抛错");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/loopback|127\.0\.0\.1|localhost/i);
        expect(msg).toMatch(/tailscale|100\.64\.0\.0\/10|fd7a/i);
        expect(msg).toMatch(/OPENRIG_AUTH_BEARER_TOKEN|bearer/i);
      }
    });

    it("DNS 解析到公网 IP 时，错误消息同时列出主机名和解析后的 IP", async () => {
      const dns = await import("node:dns");
      const spy = vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "203.0.113.45", family: 4 } as unknown as never);
      try {
        await assertBindAuthInvariant({ host: "external.example.com", bearerToken: null });
        expect.fail("应当抛错");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("external.example.com");
        expect(msg).toContain("203.0.113.45");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("findTailscaleIpInInterfaces (HG-5)", () => {
    function iface(opts: Partial<NetworkInterfaceInfo> & { address: string }): NetworkInterfaceInfo {
      return {
        address: opts.address,
        netmask: opts.netmask ?? "255.255.255.0",
        family: opts.family ?? "IPv4",
        mac: opts.mac ?? "00:00:00:00:00:00",
        internal: opts.internal ?? false,
        cidr: opts.cidr ?? null,
      } as NetworkInterfaceInfo;
    }

    it("存在 CGNAT 范围接口时返回 tailscale IPv4", () => {
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "127.0.0.1", internal: true })],
        en0: [iface({ address: "192.168.1.5" })],
        utun4: [iface({ address: "100.95.124.51" })],
      });
      expect(result).toBe("100.95.124.51");
    });

    it("仅存在 IPv6 tailnet 地址时返回 tailscale ULA IPv6", () => {
      const result = findTailscaleIpInInterfaces({
        utun4: [iface({ address: "fd7a:115c:a1e0::1", family: "IPv6" })],
      });
      expect(result).toBe("fd7a:115c:a1e0::1");
    });

    it("没有接口位于 tailnet 范围内时返回 null（HG-7 条件）", () => {
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "127.0.0.1", internal: true })],
        en0: [iface({ address: "192.168.1.5" })],
      });
      expect(result).toBeNull();
    });

    it("即使地址形似 CGNAT，也跳过内部接口（回环）", () => {
      // 纵深防御：internal 标志应优先于 IP 匹配。
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "100.95.124.51", internal: true })],
      });
      expect(result).toBeNull();
    });

    it("妥善忽略 undefined 接口条目", () => {
      const result = findTailscaleIpInInterfaces({ ghost: undefined });
      expect(result).toBeNull();
    });
  });

  describe("中间件集成", () => {
    function appWithMiddleware(token: string | null): Hono {
      const app = new Hono();
      app.use("*", authBearerTokenMiddleware({ expectedToken: token }));
      app.get("/", (c) => c.json({ ok: true }));
      return app;
    }

    it("仅回环模式（token=null）允许所有请求", async () => {
      const app = appWithMiddleware(null);
      const res = await app.request("/");
      expect(res.status).toBe(200);
    });

    it("缺少 Authorization 时返回包含三段式正文的 401", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/");
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
      expect(body.what_failed).toContain("缺少 Authorization 请求头");
      expect(body.why_it_matters).toBeDefined();
      expect(body.what_to_do).toBeDefined();
    });

    it("Authorization 不是 Bearer 方案时返回 401", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("Bearer");
    });

    it("Bearer token 不匹配时返回 401", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("不匹配");
    });

    it("Bearer token 匹配时返回 200", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });

    it("接受不区分大小写的 authorization 标头（HTTP 标准）", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });
  });
});
