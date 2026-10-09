// 51-09 increment 2b——self-host id ↔ registry-id 对齐（arch ruling dfa65bfc）。
//
// 裁定：解释（ii）——不存在 registry self-row（与 closed HostEntry union 类型不一致）；
// alignment 属性要求生成的 self-host id 必须通过 registry-id validator 且不属于保留集合，
// 使 remote host 可将其作为 registry key（transport-carries-host）。boot 时校验，fail closed。
// validator 是 CLI/daemon lockstep twin（hosts-registry-reader.ts ↔ cli/host-registry.ts，
// 已由 parity 固定）。

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SelfHostIdentityStore } from "../src/domain/seat-identity-store.js";
import {
  reconcileSelfHostIdentity,
  assertSelfHostIdRegistryAligned,
} from "../src/domain/seat-identity-reconciler.js";
import { validateHostRegistry as daemonValidate } from "../src/domain/hosts/hosts-registry-reader.js";
import { validateHostRegistry as cliValidate } from "../../cli/src/host-registry.js";

describe("51-09 incr2b：self-host id ↔ registry-id 对齐", () => {
  it("registry-valid self-id 通过 alignment assert（boot 继续）", () => {
    for (const good of ["mars-01", "vm-a.local", "host-ab12cd34", "jupiter_02"]) {
      expect(() => assertSelfHostIdRegistryAligned(good), `'${good}' 应通过`).not.toThrow();
    }
  });

  it("fail closed：无效 self-id（含 path / 保留值 / 空值）会明确抛错", () => {
    for (const bad of ["a/b", "../escape", ".hidden", "", "local", "kernel", "host"]) {
      expect(() => assertSelfHostIdRegistryAligned(bad), `'${bad}' 必须 fail closed`).toThrow(
        /registry-alignment|self-host id/,
      );
    }
  });

  it("存储的 self-id 不是有效 registry id 时 reconcile 会 fail closed（2b 前生成 / DB 篡改）", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    store.mint("bad/id", "2026-08-06T00:00:00.000Z"); // 直接预置无效 id，绕过 mint guard
    expect(() =>
      reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T01:00:00.000Z", hostNameCandidate: null }),
    ).toThrow(/注册表对齐/);
  });

  it("不采用格式无效的 host.name seed——回退到生成的 registry-valid id（不阻断 boot）", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T00:00:00.000Z",
      hostNameCandidate: "my/host",
    });
    expect(r.minted).toBe(true);
    expect(r.hostId).not.toBe("my/host");
    expect(r.hostId).toMatch(/^host-/); // 生成的 fallback
    expect(() => assertSelfHostIdRegistryAligned(r.hostId)).not.toThrow(); // 生成的 id 对 registry 有效
  });

  it("逐字采用 registry-valid host.name seed（保留正常路径）", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T00:00:00.000Z",
      hostNameCandidate: "mars-01",
    });
    expect(r.hostId).toBe("mars-01");
    expect(() => assertSelfHostIdRegistryAligned(r.hostId)).not.toThrow();
  });

  it("alignment validator 是 CLI/daemon twin——两者对每种 self-id shape 的 verdict 一致", () => {
    const SELF_ID_SHAPES: Array<{ id: string; ok: boolean }> = [
      { id: "mars-01", ok: true },
      { id: "vm-a.local", ok: true },
      { id: "host-ab12cd34", ok: true },
      { id: "a/b", ok: false },
      { id: "../escape", ok: false },
      { id: ".hidden", ok: false },
      { id: "local", ok: false },
      { id: "kernel", ok: false },
    ];
    for (const { id, ok } of SELF_ID_SHAPES) {
      const probe = { hosts: [{ id, transport: "ssh", target: "self-alignment-probe" }] };
      const d = daemonValidate(probe, "<self>");
      const c = cliValidate(probe, "<self>");
      expect(d.ok, `daemon '${id}'`).toBe(ok);
      expect(c.ok, `cli '${id}'`).toBe(ok); // twin 一致
    }
  });
});
