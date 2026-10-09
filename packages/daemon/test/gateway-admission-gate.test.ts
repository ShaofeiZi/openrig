import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { destinationRefusalTeaching, externalAdmissionTeaching } from "../src/domain/queue-repository.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { resolveExternal } from "../src/domain/gateway/external-admission.js";

// M1 A4b——queue-destination gate 的 @external entity-admission。proof-2 包含两类拒绝文本：
// ENTITY 层指引（未注册 @external，此处）和 DOMAIN 层退回（不在封闭集合中的 token 落入
// unknown_destination_rig，A1/A2）。Admission 依据 A3 registry（loadHumanRegistry）解析
// @external；已注册或 scheme 地址接纳，未注册则明确拒绝。

describe("A4b @external gate admission + proof-2 指引", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a4b-gate-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    // 注册一名 human，使 resolve 能真实命中。
    addHumanFragment({
      entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://x", role: "primary" }],
      prefs: { deliveryClass: "B" },
    }, home);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // admission 决策（topologyValidateRig 为 kind:external 返回的结果）。
  it("接纳已注册 @external，拒绝未注册项（gate boolean）", () => {
    const admit = (local: string) => {
      const entities = [{ entityId: "mike", address: "mike@external" }];
      return resolveExternal(local, entities).kind !== "unregistered";
    };
    expect(admit("mike")).toBe(true);            // 已注册。
    expect(admit("slack:U0123")).toBe(true);     // 字面 scheme（一次性地址）。
    expect(admit("stranger")).toBe(false);       // 未注册，拒绝。
  });

  // proof-2 文本 #1——面向未注册 @external 目标的 ENTITY 层指引。
  it("未注册 @external 目标以 ENTITY 指引拒绝（如何注册 + 并非 agent）", () => {
    const t = destinationRefusalTeaching("stranger@external");
    expect(t).toBeDefined();
    expect(t!.unregisteredEntity).toBe("stranger");
    expect(t!.externalDomain).toBe("external");
    expect(String(t!.hint)).toMatch(/no registered human|rig gateway human add/);
    expect(String(t!.hint)).toMatch(/NOT downgraded to an agent seat/i);
  });

  it("已注册 @external 目标被接纳（无拒绝指引）", () => {
    expect(externalAdmissionTeaching("mike@external")).toBeUndefined();
    expect(destinationRefusalTeaching("mike@external")).toBeUndefined();
  });

  // proof-2 文本 #2——DOMAIN 层：非 'external' domain 不属于 entity 问题，会落入
  // host/unknown_destination_rig 路径（无 entity 指引）。
  it("非 external domain 不获得 entity 指引（domain-bounce 路径属于 A1/A2）", () => {
    expect(externalAdmissionTeaching("mike@notexternal")).toBeUndefined();
    // 三段 host-suffix 仍通过 dispatch 获得 HOST 指引（4b 不变）。
    const host = destinationRefusalTeaching("member@rig@somehost");
    expect(host).toBeDefined();
    expect(host!.hint).toMatch(/--host/);
  });
});
