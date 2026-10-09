import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  addHumanFragment,
  listHumans,
  showHuman,
  setHumanField,
  removeHumanFragment,
  pendingConversationsFor,
  humansDir,
  projectionPath,
  projectHumans,
  loadHumanRegistry,
  type InflightItem,
} from "../src/domain/gateway/human-registry.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";

// OPR.0.5.5.12——超出 add 的 fragment lifecycle：list / show / set / remove。RED-first：这些 pin
// 针对 seeded registry 编写，在 lifecycle verb 未实现时失败（stub 返回 not-implemented；这就是
// RED）。projection-integrity 的 ABSENCE pin 是该 slice 的主干：任何 verb 都只能通过 regenerator
// 写 humans.generated.yaml。

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedMike(home: string): void {
  // 最小 authored field 集：无 away、无 handle——defaults-vs-authored fixture。
  const res = addHumanFragment(
    {
      entityId: "mike",
      class: "human",
      displayName: "Mike",
      address: "mike@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://slack/mike", role: "primary" }],
      prefs: { deliveryClass: "B" },
    },
    home,
  );
  if (!res.ok) throw new Error(`seed mike failed: ${res.error}`);
}

function seedAna(home: string): void {
  // 更完整 fragment：authored away、两个 binding、inbound-resolvable primary。
  const res = addHumanFragment(
    {
      entityId: "ana",
      class: "human",
      displayName: "Ana",
      address: "ana@external",
      connectorBindings: [
        { kind: "slack", connectorRef: "main", secretsRef: "vault://slack/ana", role: "primary", handle: "U0ANA" },
        { kind: "slack", connectorRef: "alt", secretsRef: "vault://slack/ana-alt", role: "secondary" },
      ],
      prefs: { deliveryClass: "A", away: true },
    },
    home,
  );
  if (!res.ok) throw new Error(`seed ana failed: ${res.error}`);
}

describe("gateway human lifecycle（S12，A1 修订：single-human surface）：list / show / set / remove", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "s12-lifecycle-"));
    seedMike(home); // A1: receipts run against ONE seeded human
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // ── list（A1：singular surface）──
  it("list 渲染唯一 configured human 的 loudness、availability 与 binding state——无 advisory", () => {
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.humans.map((h) => h.entityId)).toEqual(["mike"]);
    expect(res.advisory).toBeUndefined();
    const mike = res.humans[0]!;
    expect(mike.deliveryClass).toBe("B");
    expect(mike.away).toBe(false); // default applied, surfaced as the effective value
    expect(mike.bindings.count).toBe(1);
    expect(mike.bindings.primary).toEqual({ kind: "slack", connectorRef: "main" });
    expect(mike.bindings.inboundResolvable).toBe(false); // handle-less = outbound-only
    expect(mike.fragmentPath).toBe(join(humansDir(home), "mike.yaml"));
  });

  it("human 为零时 list 返回 ok empty result（teaching empty-state 由 CLI 负责）", () => {
    const empty = mkdtempSync(join(tmpdir(), "s12-empty-"));
    try {
      const res = listHumans(empty);
      expect(res.ok).toBe(true);
      if (res.ok) { expect(res.humans).toEqual([]); expect(res.advisory).toBeUndefined(); }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("A1 advisory receipt：多个 fragment 如实渲染，并附带 0.5.7 advisory（仅展示，不管理）", () => {
    seedAna(home); // hand-authored second human — the amendment's multi-fragment case
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.humans.map((h) => h.entityId)).toEqual(["ana", "mike"]); // honest, sorted display
    const ana = res.humans[0]!;
    expect(ana.deliveryClass).toBe("A");
    expect(ana.away).toBe(true);
    expect(ana.bindings.count).toBe(2);
    expect(ana.bindings.inboundResolvable).toBe(true);
    expect(res.advisory).toContain("0.5.7");
    expect(res.advisory).toContain("只支持单人管理");
  });

  it("list 是 READ：不触碰 projection 文件（byte receipt）", () => {
    const before = sha(projectionPath(home));
    const res = listHumans(home);
    expect(res.ok).toBe(true);
    expect(sha(projectionPath(home))).toBe(before);
  });

  // ── show ──
  it("show 区分 authored value 与默认值，并点名 fragment path（effective-record 诚实性）", () => {
    const res = showHuman("mike", home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.entityId).toBe("mike");
    expect(res.record.address).toBe("mike@external");
    expect(res.record.fragmentPath).toBe(join(humansDir(home), "mike.yaml"));
    // deliveryClass 已 authored；away 没有——由默认值填充。
    expect(res.record.prefs.deliveryClass).toEqual({ value: "B", source: "authored" });
    expect(res.record.prefs.away).toEqual({ value: false, source: "default" });
    // Ana 自己 authored away：
    seedAna(home);
    const ana = showHuman("ana", home);
    expect(ana.ok).toBe(true);
    if (ana.ok) expect(ana.record.prefs.away).toEqual({ value: true, source: "authored" });
  });

  it("对未知 human 执行 show 时使用已知集合给出指引", () => {
    const res = showHuman("ghost", home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("ghost");
    expect(res.error).toContain("mike"); // 点名已知 human——提供指引，而非裸 404
  });

  // ── set ──
  it("set delivery-class 编辑 fragment 并立即重新 projection（只允许 regenerator-shaped）", () => {
    const res = setHumanField("mike", "delivery-class", "D", home);
    expect(res.ok).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true); // load-time drift pin passes => projection is regenerator-authored
    if (loaded.ok) {
      const mike = loaded.entities.find((e) => e.entityId === "mike")!;
      expect(mike.prefs.deliveryClass).toBe("D");
    }
    // 磁盘 projection 与 fresh regeneration 逐字匹配——无手工拼装写入。
    const fresh = projectHumans(home);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(readFileSync(projectionPath(home), "utf8")).toBe(fresh.body);
  });

  it("set away 只接受 true|false，并以 boolean 应用", () => {
    const ok = setHumanField("mike", "away", "true", home);
    expect(ok.ok).toBe(true);
    const shown = showHuman("mike", home);
    if (shown.ok) expect(shown.record.prefs.away).toEqual({ value: true, source: "authored" });
    const bad = setHumanField("mike", "away", "maybe", home);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("true|false");
  });

  it("set 使用错误 enum 时显著失败并点名允许集合，同时让 fragment 与 projection 逐字不变", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const projBefore = sha(projectionPath(home));
    const res = setHumanField("mike", "delivery-class", "X", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/A.*B.*C.*D/); // 点名允许集合
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  it("set 使用未知字段时说明可设置字段集合，且不做修改", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const res = setHumanField("mike", "nickname", "Iron Mike", home);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("display-name");
      expect(res.error).toContain("delivery-class");
      expect(res.error).toContain("away");
      expect(res.error).toContain("binding.");
    }
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
  });

  it("set binding.<n> 使用与 add 相同的 parse+validate 替换 binding（获得 handle => inbound-resolvable）", () => {
    const res = setHumanField("mike", "binding.0", "slack:main:vault://slack/mike:primary:handle=U0MIKE", home);
    expect(res.ok).toBe(true);
    const listed = listHumans(home);
    if (listed.ok) expect(listed.humans.find((h) => h.entityId === "mike")!.bindings.inboundResolvable).toBe(true);
  });

  it("set binding.<n> 使用 malformed spec 时显著失败并给出 spec shape，且两个文件逐字不变", () => {
    const fragBefore = sha(join(humansDir(home), "mike.yaml"));
    const projBefore = sha(projectionPath(home));
    const res = setHumanField("mike", "binding.0", "slack:only", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("kind:connectorRef:secretsRef:role");
    expect(sha(join(humansDir(home), "mike.yaml"))).toBe(fragBefore);
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  it("set binding.<n> 超出范围时说明有效 index", () => {
    const res = setHumanField("mike", "binding.5", "slack:main:vault://x:primary", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("binding.0");
  });

  it("set 运行完整 add-time validator：破坏 exactly-one-primary 的 edit 整体被拒绝", () => {
    // ana：binding.1 为 secondary；将它提升为第二个 primary 必须由 add 执行的同一 cross-field
    // invariant 拒绝。（A1 下保留 two-binding mechanics。）
    seedAna(home);
    const res = setHumanField("ana", "binding.1", "slack:alt:vault://slack/ana-alt:primary", home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("primary");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true); // registry still coherent
  });

  // ── remove ──
  it("无 in-flight item 时 remove 会 archive fragment（绝不删除 byte）并重新 projection", () => {
    const fragBytes = readFileSync(join(humansDir(home), "mike.yaml"), "utf8");
    const res = removeHumanFragment("mike", { inflight: [] }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(false);
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(readFileSync(res.archivedPath, "utf8")).toBe(fragBytes); // bytes preserved verbatim
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.entities).toEqual([]);
  });

  it("存在 in-flight item 时 remove 拒绝，逐个列出 kind+id 并说明 --force", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const res = removeHumanFragment("mike", { inflight }, home);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("dec-123");
    expect(res.error).toContain("qitem-777");
    expect(res.error).toContain("open-conversation");
    expect(res.error).toContain("queue-row");
    expect(res.error).toContain("--force");
    // 没有任何内容移动：
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
  });

  it("remove --force 执行 archive，并写入点名每个 stranded item 的 orphan record（避免 silent orphan）", () => {
    const inflight: InflightItem[] = [
      { kind: "open-conversation", id: "dec-123", detail: "undelivered outbound decision dec-123" },
      { kind: "queue-row", id: "qitem-777", detail: "pending row qitem-777" },
    ];
    const before = inflight.map((i) => i.id).sort();
    const res = removeHumanFragment("mike", { force: true, inflight }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(existsSync(res.archivedPath)).toBe(true);
    expect(res.orphanRecordPath).toBeDefined();
    const orphans = JSON.parse(readFileSync(res.orphanRecordPath!, "utf8")) as { entityId: string; orphaned: InflightItem[] };
    expect(orphans.entityId).toBe("mike");
    // reconciliation：recorded set 就是 before set——没有 open item 凭空消失。
    expect(orphans.orphaned.map((i) => i.id).sort()).toEqual(before);
    // Registry 不再 projection mike：
    const loaded = loadHumanRegistry(home);
    if (loaded.ok) expect(loaded.entities.some((e) => e.entityId === "mike")).toBe(false);
  });

  it("fix-r1 F2 fs-half receipt：501 个 in-flight item force-remove 为 501 条 recorded orphan——registry layer 永不截断", () => {
    const inflight: InflightItem[] = Array.from({ length: 501 }, (_, i) => ({
      kind: "queue-row" as const,
      id: `qitem-load-${i}`,
      detail: `pending row qitem-load-${i}`,
    }));
    const res = removeHumanFragment("mike", { force: true, inflight }, home);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const orphans = JSON.parse(readFileSync(res.orphanRecordPath!, "utf8")) as { orphaned: InflightItem[] };
    expect(orphans.orphaned).toHaveLength(501);
    expect(orphans.orphaned.some((i) => i.id === "qitem-load-500")).toBe(true);
  });

  it("对未知 human 执行 remove 时给出指引；registry 保持不变", () => {
    const projBefore = sha(projectionPath(home));
    const res = removeHumanFragment("ghost", { inflight: [] }, home);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ghost"); // 指引点名未知 id
    expect(sha(projectionPath(home))).toBe(projBefore);
  });

  // ── projection integrity，跨 verb ABSENCE pin ──
  it("四个 verb 的 projection 始终只有 regenerator-shaped（每一步都有 hash receipt）", () => {
    const regeneratorShaped = () => {
      const fresh = projectHumans(home);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(readFileSync(projectionPath(home), "utf8")).toBe(fresh.body);
    };
    expect(listHumans(home).ok).toBe(true); regeneratorShaped();
    expect(showHuman("mike", home).ok).toBe(true); regeneratorShaped();
    expect(setHumanField("mike", "delivery-class", "C", home).ok).toBe(true); regeneratorShaped();
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true); regeneratorShaped();
  });

  it("lifecycle 写入后 hand-edit 路径仍拒绝（drift pin 不变）", () => {
    expect(setHumanField("mike", "delivery-class", "C", home).ok).toBe(true);
    writeFileSync(projectionPath(home), readFileSync(projectionPath(home), "utf8") + "# sneaky\n");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/手工编辑|漂移/);
  });

  // ── open-conversation source（dispatch buffer）──
  it("pendingConversationsFor 只呈现绑定到 entity 且未 Ack 的 outbound decision", () => {
    const buf = new DispatchBuffer(home);
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-ana-1", op: "post", entityBindingRef: "ana@external", payload: {} });
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-ana-2", op: "post", entityBindingRef: "ana:slack:main", payload: {} });
    buf.enqueue({ kind: "outbound_decision", decisionId: "dec-bob-1", op: "post", entityBindingRef: "bob@external", payload: {} });
    const items = pendingConversationsFor("ana", home);
    expect(items.map((i) => i.id).sort()).toEqual(["dec-ana-1", "dec-ana-2"]);
    expect(items.every((i) => i.kind === "open-conversation")).toBe(true);
  });

  it("archive filename 可安全避免 collision：remove、重新 add、再次 remove 后保留两份 archive", () => {
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true);
    seedMike(home);
    expect(removeHumanFragment("mike", { inflight: [] }, home).ok).toBe(true);
    const archiveDir = join(humansDir(home), ".archive");
    const archived = readdirSync(archiveDir).filter((f) => f.includes("mike") && f.endsWith(".yaml"));
    expect(archived.length).toBe(2);
  });
});
