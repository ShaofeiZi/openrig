import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { classifyProbeError, probeHealthz } from "../src/domain/crash-cart-probes.js";

// 保证拒绝连接的本地 port：绑定临时 port、记录后关闭 → 此时连接会被拒绝（真实 RST）。
// 这是真实 socket refusal，而非手工构造 error，因此测试获得 Node 的实际 rejection shape
//（guard round-6 / r1：stub error shape 是对 Node 行为的声明，应使用 socket 验证）。
async function refusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Crash-cart C3——真实 /healthz probe classification（供 resolveDaemonState 使用）。connection
// REFUSED 是唯一强 down signal；timeout/abort 为 UNVERIFIED；2xx 为 answered；非 2xx（或 foreign
// occupant）为 not-openrig。注入 fetch，使 classification 具有确定性。

describe("classifyProbeError——fetch rejection → probe result", () => {
  it("ECONNREFUSED → refused（唯一强 down signal）", () => {
    expect(classifyProbeError({ code: "ECONNREFUSED" })).toBe("refused");
  });
  it("AbortError（超时）→ timeout", () => {
    expect(classifyProbeError({ name: "AbortError" })).toBe("timeout");
    expect(classifyProbeError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe("timeout");
    expect(classifyProbeError({ code: "ETIMEDOUT" })).toBe("timeout");
  });
  it("其他 error → timeout（保守：unverified，绝不伪造 down）", () => {
    expect(classifyProbeError({ code: "EHOSTUNREACH" })).toBe("timeout");
    expect(classifyProbeError({})).toBe("timeout");
  });

  // GUARD round-6 blocker：真实 Node/Undici fetch 将 refusal 嵌入 `cause`；外层 error 是 code 为
  // undefined 的裸 TypeError "fetch failed"。只检查外层 error 会误标记已停止 daemon。
  it("嵌套 cause.code ECONNREFUSED（真实 undici fetch shape）→ refused", () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65534"), { code: "ECONNREFUSED" }),
    });
    expect(classifyProbeError(wrapped)).toBe("refused");
  });
  it("AggregateError cause（multi-address host）的 .errors 含 ECONNREFUSED → refused", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [Object.assign(new Error("v6"), { code: "ECONNREFUSED" }), Object.assign(new Error("v4"), { code: "ECONNREFUSED" })],
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause: agg });
    expect(classifyProbeError(wrapped)).toBe("refused");
  });
  it("嵌套 connect-timeout 仍为 timeout（保持保守，不弱化为 down）", () => {
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    expect(classifyProbeError(wrapped)).toBe("timeout");
  });

  // GUARD round-7 blocker：混合的 multi-address AggregateError（一个 address 被拒绝，另一个超时）
  // 是 ambiguous。refusal 不得按优先级胜出——timeout 绝不能升级为 confirmed down，因此 cart
  // 绝不会基于部分证据提供 RESTORE EVERYTHING。
  it("混合 aggregate（ECONNREFUSED + ETIMEDOUT）→ timeout，绝不升级为 down", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [
        Object.assign(new Error("v6 refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("v4 timed out"), { code: "ETIMEDOUT" }),
      ],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("refused 要求所有 terminal attempt 都被拒绝——refused + unknown sibling 仍为 timeout", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [{ code: "ECONNREFUSED" }, { code: "EHOSTUNREACH" }],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("refused + abort sibling 仍为 timeout（abort 不会共同升级为 down）", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), Object.assign(new Error("aborted"), { name: "AbortError" })],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("全部 refused 的 multi-address aggregate 仍为 refused（修复不会过度收窄）", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("refused");
  });

  // GUARD round-8 blocker："没有已知坏 sibling"（否定 code set）会抹去无 code 的 terminal failure——
  // 它不属于任何 set，导致 refused+codeless 被错误升级为 down。正向形式（每个 terminal attempt
  // 都是 ECONNREFUSED）不会受骗：无 code attempt 不是 refusal → ambiguous。
  it("refused + 无 code 的 terminal sibling → timeout（正向形式：并非全部 refused）", () => {
    const agg = Object.assign(new Error("all attempts failed"), {
      name: "AggregateError",
      errors: [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), new Error("terminal failure without a code")],
    });
    expect(classifyProbeError(Object.assign(new TypeError("fetch failed"), { cause: agg }))).toBe("timeout");
  });
  it("外层 wrapper 不算 terminal attempt——无 cause 的裸 'fetch failed' → timeout，而非 refused", () => {
    expect(classifyProbeError(new TypeError("fetch failed"))).toBe("timeout");
  });

  // GUARD round-9 blocker：exhaustion 不得成为 evidence。chain 深度超过遍历上限，且达到上限的
  // node 是 ECONNREFUSED wrapper、真实无 code terminal 位于上限之后时，不得计入 wrapper 自身 code——
  // cap-exhaustion-with-children 为 UNRESOLVED → 无法全体一致 → timeout。
  it("深层 capped wrapper（ECONNREFUSED wrapper 下方有无 code terminal）→ timeout，绝不升级为 down", () => {
    let node: unknown = new Error("code-less terminal deep below the walk cap"); // no code
    for (let i = 0; i < 30; i++) node = Object.assign(new Error(`wrapper ${i}`), { code: "ECONNREFUSED", cause: node });
    expect(classifyProbeError(node)).toBe("timeout");
  });
  // self-referential cause cycle 无法完整解析 → unknown → timeout（且必须结束）。
  it("self-cycle cause（a.cause = a）→ timeout（cycle 是 unknown、不升级为 down，且不无限循环）", () => {
    const a = Object.assign(new Error("self"), { code: "ECONNREFUSED" }) as Error & { cause?: unknown };
    a.cause = a;
    expect(classifyProbeError(a)).toBe("timeout");
  });
  // 横跨 AggregateError 分支的双 node cycle 也解析为 unknown → timeout。
  it("mutual cycle（a.cause=b、b.cause=a）→ timeout", () => {
    const a = Object.assign(new Error("a"), { code: "ECONNREFUSED" }) as Error & { cause?: unknown };
    const b = Object.assign(new Error("b"), { code: "ECONNREFUSED" }) as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifyProbeError(a)).toBe("timeout");
  });
});

describe("probeHealthz——production path：真实 refused socket，而非伪造 error", () => {
  it("真实 global fetch 访问已关闭的本地 port → refused（crash-cart probe 实际看到的 shape）", async () => {
    const port = await refusedPort();
    const r = await probeHealthz(`http://127.0.0.1:${port}/healthz`, {
      fetch: (u, init) => fetch(u, init as RequestInit),
      timeoutMs: 1500,
    });
    // cause-walking 修复前，这里返回 "timeout" → "unverified" → 无 cockpit。daemon-down signal
    // 必须穿过 Node 的 cause nesting，使 crash-cart 能进入 cockpit + RESTORE。
    expect(r).toBe("refused");
  });
});

describe("probeHealthz——注入的 fetch", () => {
  it("2xx → answered", async () => {
    const r = await probeHealthz("http://x/healthz", { fetch: async () => ({ ok: true, status: 200 }) as Response, timeoutMs: 500 });
    expect(r).toBe("answered");
  });
  it("非 2xx（foreign occupant）→ not-openrig", async () => {
    const r = await probeHealthz("http://x/healthz", { fetch: async () => ({ ok: false, status: 404 }) as Response, timeoutMs: 500 });
    expect(r).toBe("not-openrig");
  });
  it("连接被拒绝 → refused", async () => {
    const r = await probeHealthz("http://x/healthz", {
      fetch: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      timeoutMs: 500,
    });
    expect(r).toBe("refused");
  });
  it("abort/timeout → timeout", async () => {
    const r = await probeHealthz("http://x/healthz", {
      fetch: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      timeoutMs: 500,
    });
    expect(r).toBe("timeout");
  });
});
