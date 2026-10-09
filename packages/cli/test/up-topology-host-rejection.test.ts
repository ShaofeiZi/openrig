// OPR.0.4.4.11——R11-2 CLI 腿：`rig up --host <id> <topology>` 在
// pre-dispatch 被拒；逐 entry `host:` 是唯一拓扑放置机制。
//（daemon 路由在其公共 write 路径携带同一拒绝——
// 双侧裁定；该腿 pin 于 daemon 路由测试。）

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceLooksLikeTopology, HOST_TOPOLOGY_REJECTION } from "../src/commands/up.js";

describe("sourceLooksLikeTopology (the R11-2 pre-dispatch detector)", () => {
  it("detects the .rigtopology extension in bare and path forms without touching the fs", () => {
    expect(sourceLooksLikeTopology("factory.rigtopology")).toBe(true);
    expect(sourceLooksLikeTopology("./nonexistent-dir/factory.rigtopology")).toBe(true);
    expect(sourceLooksLikeTopology("FACTORY.RIGTOPOLOGY")).toBe(true);
  });

  it("detects a path-form YAML file carrying a top-level rigs: list", () => {
    const dir = mkdtempSync(join(tmpdir(), "r11-2-"));
    const topo = join(dir, "factory.yaml");
    writeFileSync(topo, "rigs:\n  - source: a\n");
    const spec = join(dir, "rig.yaml");
    writeFileSync(spec, "name: x\npods: []\n");
    expect(sourceLooksLikeTopology(topo)).toBe(true);
    expect(sourceLooksLikeTopology(spec)).toBe(false); // rig specs pass through untouched
    rmSync(dir, { recursive: true, force: true });
  });

  it("never sniffs name-form sources (rig-name precedence preserved) and stays false on missing/unparseable files", () => {
    expect(sourceLooksLikeTopology("factory")).toBe(false); // bare name — --host + name stays a valid remote restore
    expect(sourceLooksLikeTopology("my-rig-name")).toBe(false);
    expect(sourceLooksLikeTopology("./no/such/file.yaml")).toBe(false);
  });

  it("the rejection message names per-entry host: as the only placement mechanism", () => {
    expect(HOST_TOPOLOGY_REJECTION).toContain("按条目写 'host:'");
    expect(HOST_TOPOLOGY_REJECTION).toContain('唯一');
  });
});
