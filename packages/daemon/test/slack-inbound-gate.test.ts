import { describe, it, expect } from "vitest";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "../src/domain/gateway/slack/inbound-admission.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { resolveSlackHandle } from "@openrig/daemon/gateway-human-registry";
import type { HumanFragment } from "@openrig/daemon/gateway-human-registry";

// M1 A6 v3——入站 REGISTRATION 门。admit-iff-registered：入站 Slack 消息仅在其 sender
// 解析到已注册 human 时才成为 human-provenance qitem；source 是该 human 的 canonical
// @external 地址（绝不裸 platform id）。未注册 sender——或 registry 加载失败——被 REFUSE
//（绝不虚构 seat）。

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-07T00:00:00Z");
const ev = (user: string, ts = "200.1"): SlackEvent => ({ type: "message", user, text: "hi", ts, channel: "C1" });

function makeRouter(resolveSender: (u: string) => { admitted: true; source: string } | { admitted: false; teaching: string }) {
  const fs = memFs();
  const creates: { source: string; destination: string }[] = [];
  const logs: string[] = [];
  // S10 port：queue seam 现在是 in-process port（rig-CLI runner 已退休）。
  const queue = {
    createQitem: async (input: { source: string; destination: string }) => {
      creates.push({ source: input.source, destination: input.destination });
      return "qitem-in-9";
    },
  };
  const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
  const router = new InboundRouter({ queue, seen: new SeenStore("/s.jsonl", fs, clock), deadLetter: dead, destination: "operator-agent@kernel", resolveSender, log: (m) => logs.push(m) });
  return { router, creates, logs, dead };
}
const srcOf = (creates: { source: string }[]): string | undefined => creates[0]?.source;

describe("A6 v3 入站 registration 门（InboundRouter）", () => {
  it("REGISTERED sender 落地时 source 为 entity @external 地址（绝不裸 Slack id）", async () => {
    const { router, creates } = makeRouter((u) => (u === "U012" ? { admitted: true, source: "mike@external" } : { admitted: false, teaching: "no" }));
    const r = await router.route(ev("U012"));
    expect(r.landed).toBe(true);
    expect(srcOf(creates)).toBe("mike@external");
    expect(srcOf(creates)).not.toContain("U012"); // provenance 是注册 ref，不是 platform id
  });

  it("UNREGISTERED sender 被 REFUSE——不创建 qitem、不 dead-letter、LOUD teaching 入日志", async () => {
    const { router, creates, logs, dead } = makeRouter((u) => ({ admitted: false, teaching: `'${u}' is not a registered human — rig gateway human add …` }));
    const r = await router.route(ev("USTRANGER"));
    expect(r.landed).toBe(false);
    expect(creates).toHaveLength(0); // 从未尝试 create
    expect(dead.readAll()).toHaveLength(0); // 策略拒绝不 dead-letter（retry 无用）
    expect(logs.some((l) => /已拒绝.*USTRANGER.*未注册/.test(l))).toBe(true);
  });
});

describe("A6 v3 makeInboundSenderResolver（registry 接线；真实 resolveSlackHandle）", () => {
  const mike: HumanFragment = {
    entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
    connectorBindings: [{ kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/mike", role: "primary", handle: "U012" }],
    prefs: { deliveryClass: "B" },
  };
  const mkSurface = (loaded: ReturnType<RegistrySurface["loadHumanRegistry"]>): RegistrySurface => ({ loadHumanRegistry: () => loaded, resolveSlackHandle });

  it("已注册 handle → admitted，带 entity 地址", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: true, entities: [mike] }));
    expect(resolve("U012")).toEqual({ admitted: true, source: "mike@external" });
  });

  it("未知 handle → refused，带 resolver 的 teaching", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: true, entities: [mike] }));
    const r = resolve("UNOPE");
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.teaching).toMatch(/不是已注册人类/);
  });

  it("registry LOAD FAILURE → refused、fail-CLOSED、呈现 reg.error（r1 A4b follow-on）", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: false, error: "projection DRIFTED from the fragments" }));
    const r = resolve("U012");
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.teaching).toMatch(/fail-closed/i);
      expect(r.teaching).toMatch(/projection DRIFTED/); // 独特的 broken-registry 原因被呈现
    }
  });
});
