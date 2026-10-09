// Slice 14 §0 —— 证明该 slice 的 RED。
//
// 真实缺陷：每条消息都会渲染回复提示 `member@rig@<selfHostId>`，代码中总是追加 host 的理由
// 是该提示「可逐字使用」。实则不然。一个 peer 逐字使用后得到 `no registered host
// 'host-84c37990'`——因为接收方注册表只以人类 ALIAS 认识该机器，而解析仅用后缀去匹配
// `h.id`。两套命名系统，无连接键。
//
// 失败是不对称的，这是最尖锐的形式：仅当发送方的 self-id 恰好等于接收方注册表所写时，
// 提示才能路由。同一机制，相反结果。
//
// 仅适用于多主机。单机上此处无任何变化或改进。

import { describe, it, expect } from "vitest";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";
import type { HostRegistry } from "../src/host-registry.js";

/** One http entry: the human alias an operator typed, joined to the id that host mints for itself. */
function boundRegistry(): { ok: true; registry: HostRegistry } {
  return {
    ok: true,
    registry: {
      hosts: [{
        id: "mm2-host",
        transport: "http",
        url: "http://x:7433",
        hostId: "host-84c37990",
      }],
    },
  };
}

/** The same entry as it exists today on every live registry: no join key at all. */
function unboundRegistry(): { ok: true; registry: HostRegistry } {
  return {
    ok: true,
    registry: { hosts: [{ id: "mm2-host", transport: "http", url: "http://x:7433" }] },
  };
}

describe("cross-host target resolution — alias -> id -> transport", () => {
  it("resolves a reply hint carrying the peer's SELF-ID against the registry join key", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    // 归一化为 ALIAS：人类 handle 是规范注册表键，一切
    // downstream that compares against `h.id` keeps working unchanged.
    expect(r.sugarHost).toBe("mm2-host");
    expect(r.hint).toBeUndefined();
  });

  it("still resolves when the operator types the human alias", () => {
    const r = resolveCrossHostTarget("pm@some-rig@mm2-host", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBe("mm2-host");
  });

  // The unbound entry is every entry that exists today. Migration is lazy and non-destructive, so
  // this must keep behaving exactly as it does now — an honest miss, not a new failure mode.
  it("still reports an unresolvable self-id when the entry has no join key yet", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", undefined, unboundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig@host-84c37990");
    expect(r.sugarHost).toBeUndefined();
    expect(r.hint).toContain("无已注册主机 'host-84c37990'");
  });

  // Two spellings of ONE host. An operator who pastes back the reply hint we printed them AND
  // passes --host with the human alias is naming the same machine twice, not two machines.
  it("accepts --host alias beside a target suffix that is the same entry's join key", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "mm2-host", boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBe("mm2-host");
  });

  it("still rejects --host naming a genuinely DIFFERENT registered host", () => {
    const two = () => ({
      ok: true as const,
      registry: {
        hosts: [
          { id: "mm2-host", transport: "http" as const, url: "http://x:7433", hostId: "host-84c37990" },
          { id: "other-host", transport: "http" as const, url: "http://y:7433", hostId: "host-deadbeef" },
        ],
      },
    });
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "other-host", two, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("主机歧义");
  });

  it("still rejects an --host that resolves to nothing", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-84c37990", "not-registered", boundRegistry, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("主机歧义");
  });

  it("leaves a plain two-part target alone", () => {
    const r = resolveCrossHostTarget("pm@some-rig", undefined, boundRegistry, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBeUndefined();
  });

  // A message addressed to THIS machine's own self-id is not a cross-host message; the home-route
  // strip must keep winning over any registry match.
  it("strips this host's own self-id without routing anywhere", () => {
    const r = resolveCrossHostTarget("pm@some-rig@host-SELF", undefined, boundRegistry, "host-SELF");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBe("pm@some-rig");
    expect(r.sugarHost).toBeUndefined();
  });
});
