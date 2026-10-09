import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../src/index.js";
// registry 模块由 daemon 拥有 home-state；该动词（及本测试）经窄
// @openrig/daemon/gateway-human-registry 子路径触达（C3/crash-cart 轨道）。
import { humansDir, loadHumanRegistry } from "@openrig/daemon/gateway-human-registry";

// M1 A3 pt2 / A4b 重定位——`rig gateway human add` 动词集成。该动词懒加载
// 重定位后的 daemon 表面；这些测试端到端驱动真实命令。
describe("rig gateway human add verb (post-relocate)", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a3-verb-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    process.exitCode = undefined;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("is wired via createProgram (gateway human add)", () => {
    const gw = createProgram().commands.find((c) => c.name() === "gateway");
    expect(gw).toBeDefined();
    const human = gw!.commands.find((c) => c.name() === "human");
    expect(human!.commands.find((c) => c.name() === "add")).toBeDefined();
  });

  it("add writes a fragment + projection; address DERIVED; vault-pointer secretsRef (with ':') survives", async () => {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike",
      "--binding", "slack:main:vault://slack/mike:primary",
      "--delivery-class", "B",
    ]);
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.entities[0]!.address).toBe("mike@external");
      expect(loaded.entities[0]!.connectorBindings[0]!.secretsRef).toBe("vault://slack/mike");
    }
  });

  it("A6 v3: an OPTIONAL handle= token parses alongside a ':'-bearing secretsRef (inbound-resolvable)", async () => {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike",
      "--binding", "slack:main:vault://slack/mike:primary:handle=U012AB3CD",
      "--delivery-class", "B",
    ]);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const b = loaded.entities[0]!.connectorBindings[0]!;
      expect(b.secretsRef).toBe("vault://slack/mike"); // the ':'-bearing pointer survived intact
      expect(b.handle).toBe("U012AB3CD");              // and the handle was extracted
    }
  });

  it("add REFUSES an existing entityId (no silent clobber; exit 1)", async () => {
    const args = [
      "node", "rig", "gateway", "human", "add", "mike",
      "--display-name", "Mike", "--binding", "slack:main:vault://x:primary", "--delivery-class", "B",
    ];
    const p1 = createProgram(); p1.exitOverride();
    await p1.parseAsync(args);
    expect(process.exitCode).toBeUndefined();
    process.exitCode = undefined;
    const p2 = createProgram(); p2.exitOverride();
    try { await p2.parseAsync(args); } catch { /* action sets exitCode, not throw */ }
    expect(process.exitCode).toBe(1);
  });
});
