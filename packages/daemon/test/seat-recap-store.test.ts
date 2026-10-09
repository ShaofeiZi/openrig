// OPR.0.5.3.5 RECAP atom（mini-req 7 / Q2 + Q2-Amendment 1）——seat recap store：
// AUTHORED recap 是在 boundary 由 outgoing occupant 编写的带 rationale 决策；按 Q2
// unify-what-exists 裁定，扩展正式 from-record boot recap 的名称。它位于席位目录、与 LEARNED
// 并列；在席位目录下保留 SUPERSEDED-CHAIN（最新项为 current，前任保留，由 seat-directory
// lifecycle 清理，而非 librarian）。authoring contract 对可检查子集做 ADVISORY 验证；finding
// 只标记 review，绝不 gate handover（D2 模式：prose shape 不得阻塞 boundary）。

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeSeatRecap, listRecapChain, validateRecapContract } from "../src/domain/context-packs/seat-recap-store.js";

const GOOD_RECAP = [
  "## Recent Decisions",
  "We chose X because Y outweighed Z at the time.",
  "UNVERIFIED: the Z cost figure came second-hand from the ops channel.",
  "## Open Threads",
  "Derive the live count with `rig queue list --mine` rather than trusting this snapshot.",
].join("\n");

let seatDir: string;
beforeEach(() => { seatDir = mkdtempSync(join(tmpdir(), "s05-recap-")); });
afterEach(() => rmSync(seatDir, { recursive: true, force: true }));

describe("writeSeatRecap——superseded-chain 保留（Q2-Amendment 1(b)）", () => {
  it("首次写入创建 RECAP.md；第二次写入把首份移入 chain 并逐字节保留", () => {
    let t = 1000;
    writeSeatRecap({ seatDir, content: "## Recent Decisions\nfirst era", now: () => t });
    t = 2000;
    writeSeatRecap({ seatDir, content: GOOD_RECAP, now: () => t });
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe(GOOD_RECAP);
    const chain = listRecapChain(seatDir);
    expect(chain).toHaveLength(1);
    expect(readFileSync(chain[0]!.path, "utf-8")).toBe("## Recent Decisions\nfirst era");
    // chain 位于席位目录下，由 seat-directory lifecycle 负责清理；名称按 supersession 时间排序。
    expect(chain[0]!.path.startsWith(seatDir)).toBe(true);
  });

  it("三个 era：chain 从最旧开始列出，current 文件始终最新", () => {
    let t = 1;
    for (const era of ["one", "two", "three"]) {
      writeSeatRecap({ seatDir, content: `## Recent Decisions\n${era}`, now: () => t++ });
    }
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("three");
    const chain = listRecapChain(seatDir);
    expect(chain.map((c) => readFileSync(c.path, "utf-8"))).toEqual([
      "## Recent Decisions\none",
      "## Recent Decisions\ntwo",
    ]);
  });

  it("r1 F1：同一毫秒内 supersession 不丢内容，每个 predecessor 均逐字节保留", () => {
    // r1 构造的破坏：renameSync 到现有路径会替换它，因此同一毫秒的两次 supersession 覆盖首个
    // chain entry，静默颠倒“逐字节保留、只由 lifecycle 清理”的 retention contract。now 可注入，
    // 所以程序化调用方会确定性冲突，而不只是偶发。
    let t = 5000;
    writeSeatRecap({ seatDir, content: "## Decisions\nv1", now: () => t });
    t = 7777;
    writeSeatRecap({ seatDir, content: "## Decisions\nv2", now: () => t });
    writeSeatRecap({ seatDir, content: "## Decisions\nv3", now: () => t }); // same ms
    const chain = listRecapChain(seatDir);
    expect(chain).toHaveLength(2);
    const bodies = chain.map((c) => readFileSync(c.path, "utf-8"));
    expect(bodies).toContain("## Decisions\nv1");
    expect(bodies).toContain("## Decisions\nv2");
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe("## Decisions\nv3");
  });

  it("r1 额外属性：未通过 gate 的写入不触碰 current recap 或 chain", () => {
    writeSeatRecap({ seatDir, content: "## Decisions\nstanding era", now: () => 1 });
    expect(() => writeSeatRecap({ seatDir, content: "## Same\na\n## Same\nb", now: () => 2 })).toThrow();
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe("## Decisions\nstanding era");
    expect(listRecapChain(seatDir)).toHaveLength(0);
  });

  it("current recap 保持可寻址：明确拒绝无法寻址的写入，因为它永远无法 compose", () => {
    // recap 按地址（seat:RECAP.md#...）compose；无法解析的 recap 会在下游让每个 handover
    // profile 延迟且静默失败。这是唯一非 advisory gate，约束的是重复 header path / 未结束 fence
    // 等结构，而不是 prose shape。
    expect(() => writeSeatRecap({ seatDir, content: "## Same\na\n## Same\nb", now: () => 1 }))
      .toThrow(/duplicate|addressab/i);
  });
});

describe("validateRecapContract——可检查子集与 advisory finding（Q2 authoring contract）", () => {
  it("符合 contract 结构的 recap 不产生 finding", () => {
    expect(validateRecapContract(GOOD_RECAP)).toEqual([]);
  });

  it("标记缺失 decisions section；只有结论而无决策属于有损 handoff", () => {
    const findings = validateRecapContract("## Status\nall done, trust me");
    expect(findings.some((f) => f.kind === "no-decisions-section")).toBe(true);
  });

  it("标记小写或变体 unverified marker；一个错误事实会污染之后每轮，marker 必须可查找", () => {
    const findings = validateRecapContract("## Recent Decisions\nchose X because Y.\n(unverified: the Y figure)");
    expect(findings.some((f) => f.kind === "nonstandard-unverified-marker")).toBe(true);
  });

  it("finding 绝不抛错；contract 只给建议，boundary 不因 prose shape 阻塞", () => {
    expect(() => validateRecapContract("free prose, no headers at all")).not.toThrow();
  });
});

// BUILD FOLLOW-UP（r1 verdict bb00e850 obs；orch-lead row 17015088）——seat-ref 解析统一
// 使用 canonical parseSessionName（按第一个 @ 分割，即已有文档的 greedy-rig 裁定），不再使用
// 第二套 lastIndexOf parser。保留安全下限：无法解析/不匹配的 ref 以带标签路径失败，绝不模糊
// 匹配到其他席位。
describe("resolveAuthoredRecapPointer——单一归属的 seat-ref 解析（canonical parseSessionName）", () => {
  it("两段 canonical ref 解析到席位目录（本地对照）", async () => {
    const { resolveAuthoredRecapPointer } = await import("../src/domain/context-packs/seat-recap-store.js");
    const { mkdirSync: mkd, writeFileSync: wf } = await import("node:fs");
    mkd(join(seatDir, "rigs", "r1", "seats", "s1"), { recursive: true });
    wf(join(seatDir, "rigs", "r1", "seats", "s1", "RECAP.md"), "## Recent Decisions\nx");
    const res = resolveAuthoredRecapPointer("s1@r1", seatDir);
    expect(res).toEqual({ address: "seat:RECAP.md", chainLength: 0 });
  });

  it("HOST-QUALIFIED 三段 ref：席位是首个 segment，并以尝试路径做带标签降级", async () => {
    // 判别项：lastIndexOf('@') 会读成 seat='s1@r1' rig='host-x'；canonical split 按设计的
    // greedy-rig 读成 member='s1' rig='r1@host-x'。两种方式都找不到目录，但带标签路径必须反映
    // canonical parse，使 absence 文本指向真实结构。
    const { resolveAuthoredRecapPointer } = await import("../src/domain/context-packs/seat-recap-store.js");
    const res = resolveAuthoredRecapPointer("s1@r1@host-x", seatDir);
    expect("absentReason" in res).toBe(true);
    const reason = (res as { absentReason: string }).absentReason;
    expect(reason).toContain(join("rigs", "r1@host-x", "seats", "s1"));
  });

  it("malformed ref 是点明 parse verdict 的带标签 absence，绝不抛错或猜测", async () => {
    const { resolveAuthoredRecapPointer } = await import("../src/domain/context-packs/seat-recap-store.js");
    for (const bad of ["noatsign", "@r1", "s1@"]) {
      const res = resolveAuthoredRecapPointer(bad, seatDir);
      expect("absentReason" in res).toBe(true);
      expect((res as { absentReason: string }).absentReason).toContain(bad);
    }
  });
});
