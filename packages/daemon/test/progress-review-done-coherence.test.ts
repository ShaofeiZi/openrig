// VM-006（progress-review-done-coherence）——Progress↔Review 的“done”
// 并集：对 proof-contract 行，buildAcceptance 派生 done = checkboxTicked 或
// qaVerified，走 Review 自己导出的 trio + 唯一的 proof-io 读取器（arch A1）。
// 计划基线：IMPLEMENTATION-PLAN-vm006 v1.2（sha256 8ad843f8…）；PRD 00ef4e18…；
// arch Cell A 30557c39…。
//
// 夹具来源（已冻结，禁止手工伪造）：test/fixtures/progress-review-done-coherence/
// 03-shared-by-label/ 下的每个字节都逐字复制自已冻结的 dogfood 工作区快照
// release-0.4.7-workspace.tar.gz（sha256
// 69d20c6a0a29edd9c76d9a1e3a10325a23fb3d8b28898c4581f1e00091682452，位于
// dogfood-evidence/release-0.4.7/revalidation-704ddb58/review-tab-fixset/），路径
// missions/release-0.4.7/slices/03-shared-by-label/。复制文件及 md5：
// README.md d6280fbf3c760af7459567d88569b5bc · IMPLEMENTATION-PRD.md
// 4020213ba8d6bec79f58fc062b8e648a · PROGRESS.md 543f616d1a2fa57d7d9b5c6095e0c7cf ·
// PROOF.md c72cf0f5357367b3d838347c624b7fa2 · proof/qa-PASS-shared-by-label.md
// 804e1210d097cb7a0b208c9d858b2c66。快照中的二进制（mockups/*、proof/*.png）略去：
// 两个派生都不读取它们（buildAcceptance 只扫描四个候选 .md 名字；readProofArtifacts
// 过滤 proof/*.md）。V2/V7 的向量是最小派生子夹具——按计划 §D，在这些冻结字节之上
// 逐测试记录编辑。
//
// 两个差分参照（都必须成立；§D 契约）：
//
//  (a) 对照 BASE 704ddb58——该特性完全不存在。每个 NEW-BEHAVIOR 断言在那里都是
//      断言形状的 RED，绝不崩溃（下方每个静态 import 在 base 都存在，故本文件可加载）：
//        V1 RED（base：total 13、done 7、pct 54、六个 ACTIVE；doneVia 缺失）·
//        V2 RED（base 为 done 但 doneVia undefined）· V3/V4 两端 GREEN（保护性）·
//        V6′ 两端 GREEN（委派金丝雀）· V7a RED · V7b 经其 doneItems 上下文断言 RED
//        （其 no-false-join CORE 断言为 base-green 保护性）· V8 除 (c) 的 doneVia 印记外
//        GREEN · FS-1c RED（0 次 readdir 对 1 次）；FS-1a/b 两端 GREEN。
//
//  (b) 对照冻结前驱 0ec6411c——B1 碰撞参照。它有该特性，但连接用的比较器会剥离内联
//      图片，比验收去重键（原始 trim+casefold）更粗。更粗的连接关系把两个不同行映射到
//      同一个 obligation：
//        RC1 在前驱 RED（一个非 contract 行被误抬）·
//        RC2 在前驱（第二个未验证的序号被抬）·
//        AMB 在前驱（一个真正有歧义的行仍被抬）。
//      v1.4（arch PIN-C Option-A）两侧都按原始 authored 文本连接，故 join-relation ==
//      dedup-relation，碰撞变为区分。INV 固定由此产生的计数不变量。
//
// 证明状态：这些处置是已断言的 §D 契约，有待 VM 差分运行确认（base-RED、前驱-RED、
// 后继-GREEN）。此处不盖确认真章——在记录的产物落地前，不声称任一腿为 green。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";

// FS-1 插桩：`vi.spyOn` 无法重定义 ESM 内置命名空间导出，故 `readdirSync` 经
// module-mock 透传包装——其余 fs 导出保持真实实现，node_modules（如
// better-sqlite3）被外置，只有图内产品代码看到包装。行为不变；包装仅记录调用。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePath from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { extractProofContract } from "../src/domain/review/compose.js";

// BASE-COMPAT（按构造遵守 VM-005 §D-bis 教训）：上方每个静态 import 在 base
// 704ddb58 都存在，故本文件在 base 可加载，RED 腿由断言失败，而非 import 崩溃。
// 不 import 任何仅候选态才有的符号。
//
// 下方 `textKey` 是本套件的 ORACLE——测试内对 v1.4 连接键（arch PIN-C Option-A）的
// 重述：对原始 authored 文本做 trim + casefold，既不剥离图片也不折叠空白，因为该键
// 必须等于验收去重表达式。在此重述而非 import 产品 helper，使 oracle 独立于被测代码。
// 产品键经 projector 端到端走查；RC1/RC2 正是更粗（剥离图片）连接键会失败的向量。
function textKey(text: string): string {
  return text.trim().toLowerCase();
}

const SLICE = "03-shared-by-label";
const FIXTURE_DIR = nodePath.resolve(
  import.meta.dirname,
  "fixtures",
  "progress-review-done-coherence",
  SLICE,
);

describe("VM-006 — Progress↔Review done coherence (union in buildAcceptance)", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupRoot: string;
  let indexer: SliceIndexer;
  let projector: SliceDetailProjector;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "vm006-coherence-"));
    slicesRoot = join(cleanupRoot, "slices");
    // 冻结夹具按测试复制，使向量可在其上派生，而绝不改动已提交字节。
    cpSync(FIXTURE_DIR, join(slicesRoot, SLICE), { recursive: true });
    indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  const sliceDir = () => join(slicesRoot, SLICE);
  const fileOf = (rel: string) => join(sliceDir(), rel);
  const editFile = (rel: string, edit: (content: string) => string) =>
    writeFileSync(fileOf(rel), edit(readFileSync(fileOf(rel), "utf8")));

  function acceptanceOf() {
    const slice = indexer.get(SLICE);
    expect(slice, `slice ${SLICE} must index`).toBeTruthy();
    return projector.project(slice!).acceptance;
  }

  /** 六个冻结的 contract obligation，按连接键的方式取键——经产品自己的 extractor 从
   *  夹具 PRD 派生（V4 正是这个交叉派生的一致性）。
   *
   *  BASE-COMPAT：`rawText` 是后继才有的字段，在 base/前驱为 undefined，故回退到
   *  `text`。该回退让此 helper 在那里不抛 TypeError——差分腿必须由断言失败，而非崩溃；
   *  且在冻结夹具上（其 contract 行不带内联图片）两个载体本就逐字节相同，无论哪种
   *  取法集合都是同样六个。 */
  function contractTextSet(): Set<string> {
    const promised = extractProofContract(readFileSync(fileOf("IMPLEMENTATION-PRD.md"), "utf8"));
    return new Set(promised.map((p) => textKey((p as { rawText?: string }).rawText ?? p.text)));
  }

  /** Review 在当前夹具字节上自己的 verified 计数——Progress 抬升绝不能超过的天花板
   * （pm FR-2 不变量 2）。 */
  function reviewVerifiedCount(): number {
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    return composed!.delivered.items.filter((i) => i.verified === "verified").length;
  }

  /** 用一个精确向量替换六个冻结 contract 行——两个载体都换（PRD 是 Review 的来源；
   *  README 行是在 README-first 去重中存活的引用）——并且只校验给定的 1 起始序号。
   *  证据侧之所以用序号（而非文本），正因 `refMatches` 也按精确文本匹配：若 authored
   *  文本重复，文本证据会同时校验两个序号，从而毁掉向量。 */
  function contractVector(rows: string[], verifiedOrdinals: string[]): void {
    const block = rows.map((r) => `- [ ] ${r}`).join("\n");
    const replaceContract = (c: string) => {
      const start = c.indexOf("- [ ] **1. Shared card label**");
      const lastRow = c.indexOf("- [ ] **6. Long-name truncation**");
      const end = c.indexOf("\n", lastRow);
      return c.slice(0, start) + block + c.slice(end);
    };
    editFile("IMPLEMENTATION-PRD.md", replaceContract);
    editFile("README.md", replaceContract);
    editFile("proof/qa-PASS-shared-by-label.md", (c) =>
      c.replace(
        /evidences:\n(?:\s+- "\d"\n)+/,
        `evidences:\n${verifiedOrdinals.map((o) => `  - "${o}"\n`).join("")}`,
      ));
  }

  // --- V1 · 重头戏：六裁决夹具读为 13/13、零 ACTIVE，与 Review 的 6 个 verified 一致 ---

  it("V1：六个 QA-verified contract 行被抬升——13/13、零 ACTIVE，与 Review 一致", () => {
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(13);
    expect(a.percentage).toBe(100);
    expect(a.items.filter((i) => !i.done)).toEqual([]);

    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict");
    expect(lifted).toHaveLength(6);
    // 被抬升的行是 contract 行——它们引用 README.md（README-first 去重），而非 PRD：
    // 连接按文本集合，绝不按 source.file。
    for (const row of lifted) expect(row.source.file).toBe("README.md");

    // 与 Review 的一致性，来自 Review 在相同字节上自己的 composition：
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    const verified = composed!.delivered.items.filter((i) => i.verified === "verified");
    expect(verified).toHaveLength(6);
    expect(lifted.length).toBe(verified.length);
  });

  // --- V2 · 并集：手工勾选但无 QA 裁决的 contract 行仍为 done ---

  it("V2：手工勾选但无裁决的 contract 行仍为 done，doneVia=checkbox（派生夹具：README 第 1 行勾选，proof/ 删除）", () => {
    editFile("README.md", (c) =>
      c.replace("- [ ] **1. Shared card label**", "- [x] **1. Shared card label**"));
    rmSync(join(sliceDir(), "proof"), { recursive: true, force: true });

    const a = acceptanceOf();
    const row1 = a.items.find((i) => i.text.includes("1. Shared card label"));
    expect(row1).toBeTruthy();
    expect(row1!.done).toBe(true);
    expect(row1!.doneVia).toBe("checkbox");
    // 其余五个 contract 行如实保持未完成（无产物）。
    expect(a.doneItems).toBe(8);
    expect(a.totalItems).toBe(13);
  });

  // --- V3 · FR-2：非 contract 行逐字节不变（text/source/done）---

  it("V3：七个 PROGRESS.md 行的 text、source、done 与 authored 完全一致", () => {
    // 独立 oracle：用 projector 自己的 checkbox 语法重新解析冻结的 PROGRESS 字节。
    const lines = readFileSync(fileOf("PROGRESS.md"), "utf8").split("\n");
    const expected: Array<{ text: string; line: number; done: boolean }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*-?\s*\[(\s|x|X)\]\s+(.+)$/);
      if (m) expected.push({ text: m[2]!.trim(), line: i + 1, done: m[1]!.toLowerCase() === "x" });
    }
    expect(expected).toHaveLength(7);

    const a = acceptanceOf();
    const progressRows = a.items.filter((i) => i.source.file === "PROGRESS.md");
    expect(progressRows.map((i) => ({ text: i.text, line: i.source.line, done: i.done })))
      .toEqual(expected);
  });

  // --- V4 · 一致性向量：两个标签页枚举同样的六个 ---

  it("V4：acceptance contract 子集文本集 ≡ DELIVERED promised 文本集（各六个）", () => {
    const promised = contractTextSet();
    expect(promised.size).toBe(6);

    const a = acceptanceOf();
    const acceptanceContractTexts = new Set(
      a.items
        .map((i) => textKey(i.text))
        .filter((t) => promised.has(t)),
    );
    expect(acceptanceContractTexts).toEqual(promised);
  });

  // --- V6′ · A1 委派金丝雀：Review 经产物派生的输出在逐字 proof-io 提取中被钉住 ---

  it("V6′：gather 的 proof 产物输出在冻结夹具上被钉住（委派金丝雀）", () => {
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => "2026-07-11T00:00:00.000Z" });
    const composed = gatherer.composeSlice(SLICE);
    expect(composed).toBeTruthy();
    const items = composed!.delivered.items;
    expect(items).toHaveLength(6);
    for (const item of items) expect(item.verified).toBe("verified");
    // 产物集合：恰好那一个 .md 投放喂给每个 deliverable 的 QA note
    //（镜像语义：.md 过滤、排序、mtime→ISO、try/catch 跳过——单一实现，可证仍在喂 Review）。
    expect(items[0]!.note).toContain("Inspected the committed diff");
    expect(composed!.delivered.proofDirPath).toContain(`${SLICE}/proof`);
  });

  // --- V7 · PIN C 图片引用连接，两个方向 ---

  it("V7a：带真实 ![shot](…) 的 contract 行仍能连接并抬升", () => {
    // 派生夹具：contract 第 6 行在两个载体都获得真实图片引用
    //（PRD = Review 的来源；README = 存活的 acceptance 引用）。
    const addShot = (c: string) =>
      c.replace(
        /- \[ \] \*\*6\. Long-name truncation\*\* — ([^\n]+)/,
        "- [ ] **6. Long-name truncation** — $1 ![shot](proof/qa-delivered-shared-by-label.png)",
      );
    editFile("README.md", addShot);
    editFile("IMPLEMENTATION-PRD.md", addShot);

    const a = acceptanceOf();
    const row6 = a.items.find((i) => i.text.includes("6. Long-name truncation"));
    expect(row6).toBeTruthy();
    expect(row6!.done).toBe(true);
    expect(row6!.doneVia).toBe("qa-verdict");
    expect(a.doneItems).toBe(13);
  });

  it("V7b：仅含图片的非 contract 行不被抬升（无误连接）", () => {
    editFile("README.md", (c) =>
      c + "\n## Follow-ups\n\n- [ ] Extra gallery polish pass ![screenshot](mockups/shared-by-label.png)\n");

    const a = acceptanceOf();
    const extra = a.items.find((i) => i.text.includes("Extra gallery polish pass"));
    expect(extra).toBeTruthy();
    expect(extra!.done).toBe(false);
    expect(extra!.doneVia).toBeUndefined();
    expect(a.totalItems).toBe(14);
    expect(a.doneItems).toBe(13);
  });

  // --- V8 · 降级安全：任何缺失都是 no-op，绝不抛错 ---

  // 2026-08-24 重新钉住（桌面裁定 row 9acb0aae）：旧钉住断言的是 one-home 之前的法则
  //（无 PRD ⇒ 无 contract）。自 546ced700 起，来源选择为 one-homed（authored PRD -> SPEC
  // -> README），故缺失或无小节的 PRD 让位于本夹具 authored 的 README contract——qa-verdict
  // 连接抬升并填充 doneVia。V8 的真实意图——缺失绝不抛错——移到 V8f，即真正缺失的情形。
  it("V8a：无 PRD + authored README ⇒ README 派生的 contract 连接并抬升（one-home 法则），不抛错", () => {
    rmSync(fileOf("IMPLEMENTATION-PRD.md"));
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(13);
    expect(a.items.some((i) => i.doneVia === "qa-verdict")).toBe(true);
  });

  it("V8b：无 Proof contract 小节的 PRD ⇒ 让位于 authored README contract，不抛错", () => {
    editFile("IMPLEMENTATION-PRD.md", (c) => c.replace("## Proof contract", "## Notes"));
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(13);
    expect(a.items.some((i) => i.doneVia === "qa-verdict")).toBe(true);
  });

  it("V8f：真正缺失——无 PRD、无 SPEC、无 authored README contract ⇒ 纯勾选态，无 doneVia，不抛错", () => {
    // 旧 V8a 的真实意图，在它仍成立处继承下来：当没有任何来源 authored contract 时，
    // acceptance 降级为勾选态，既不抬升也不抛错。
    rmSync(fileOf("IMPLEMENTATION-PRD.md"));
    editFile("README.md", (c) => c.replace("## Proof contract", "## Notes"));
    const a = acceptanceOf();
    expect(a.items.every((i) => i.doneVia === undefined)).toBe(true);
    expect(a.doneItems).toBeLessThan(13); // 仅勾选，无 qa-verdict 抬升
  });

  it("V8c：authored contract 但无 proof/ 目录 ⇒ 不抬升、不抛错；勾选行盖 checkbox", () => {
    rmSync(join(sliceDir(), "proof"), { recursive: true, force: true });
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(7);
    const promised = contractTextSet();
    for (const item of a.items) {
      if (promised.has(textKey(item.text))) {
        expect(item.done).toBe(false);
        expect(item.doneVia).toBeUndefined();
      } else {
        expect(item.done).toBe(true);
        expect(item.doneVia).toBe("checkbox");
      }
    }
  });

  it("V8d：干净 PRD contract + authored README contract ⇒ README 胜出；六行经 qa-verdict 抬升（PM dogfood #1 预期变更）", () => {
    // 用一个脚手架占位行（括号包裹的模板语法）替换 PRD 的六个 authored contract 行。
    // README 的 AUTHORED `## Proof contract`（同样六行）如今在逐小节选择中胜出，故既有 QA
    // 证据把六行全部抬升——旧的 占位行⇒no-op 预期在此夹具形状下按设计为假；无 authored
    // contract 的 no-op 钉住在 V8a（无 PRD）与 V8b（缺小节），二者不变。
    editFile("IMPLEMENTATION-PRD.md", (c) => {
      const head = c.slice(0, c.indexOf("## Proof contract"));
      const tail = c.slice(c.indexOf("## Surface"));
      return head + "## Proof contract\n\n- [ ] [Observable outcome the operator can verify]\n\n" + tail;
    });
    const a = acceptanceOf();
    expect(a.totalItems).toBe(13);
    expect(a.doneItems).toBe(13);
    expect(a.items.filter((i) => i.doneVia === "qa-verdict")).toHaveLength(6);
    expect(a.items.filter((i) => i.doneVia === "checkbox")).toHaveLength(7);
  });

  // --- B1 碰撞回归（在冻结前驱 0ec6411c 处为 RED）---
  //
  // 前驱经剥离图片的比较器，把 STRIPPED promised 文本与原始行文本连接。该关系严格粗于
  // 验收去重键，更粗的连接把不同行坍缩到同一个 obligation。v1.4 两侧都按原始 authored
  // 文本取键，故连接关系就是去重关系，这些碰撞无法形成。

  it("RC1：文本等于某 contract 行 STRIPPED 文本的非 contract 行不被抬升", () => {
    // 在两个载体都给 contract 第 6 行一个真实内联图片。它的 stripped 文本如今是我们随后
    // authored 的一个普通行的严格前缀同一——正是剥离图片连接键会坍缩到一起的那一对。
    const addShot = (c: string) =>
      c.replace(
        /- \[ \] \*\*6\. Long-name truncation\*\* — ([^\n]+)/,
        "- [ ] **6. Long-name truncation** — $1 ![shot](proof/qa-delivered-shared-by-label.png)",
      );
    editFile("README.md", addShot);
    editFile("IMPLEMENTATION-PRD.md", addShot);

    // stripped 文本取自产品自己的 extractor（`text` 在 base、前驱、后继都存在——故此处
    // 保持断言形状）。
    const promised = extractProofContract(readFileSync(fileOf("IMPLEMENTATION-PRD.md"), "utf8"));
    const row6 = promised.find((p) => p.text.includes("6. Long-name truncation"));
    expect(row6, "contract row 6 must extract").toBeTruthy();
    expect(row6!.text).not.toContain("![shot]"); // stripped carrier
    // 用恰好那些 stripped 字节 authored 的一个非 contract follow-up 行。
    editFile("README.md", (c) => `${c}\n## Follow-ups\n\n- [ ] ${row6!.text}\n`);

    const a = acceptanceOf();
    // 存在两个不同的 acceptance 行：带图的 contract 行与普通 follow-up。二者原始不同，
    // 故去重保留两者。
    const plain = a.items.filter((i) => i.text === row6!.text);
    expect(plain, "the plain follow-up row survives dedup").toHaveLength(1);
    const contractRow = a.items.find((i) => i.text.includes("6. Long-name truncation") && i.text.includes("![shot]"));
    expect(contractRow, "the image-bearing contract row survives dedup").toBeTruthy();

    // 缺陷所在：前驱把普通行也抬升，因为二者坍缩到同一个 stripped 键。它不是 obligation，
    // 绝不能被抬升。
    expect(plain[0]!.done).toBe(false);
    expect(plain[0]!.doneVia).toBeUndefined();
    // …而真正的 contract 行仍抬升（不欠计）。
    expect(contractRow!.done).toBe(true);
    expect(contractRow!.doneVia).toBe("qa-verdict");

    // INV：抬升绝不能超过 Review 的 verified 计数。
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("RC2：仅图片引用不同的两个 contract 行——只有 VERIFIED 序号抬升", () => {
    const body = "**D. Duplicate obligation** — identical authored text, different planned shot";
    contractVector(
      [`${body} ![a](mockups/one.png)`, `${body} ![b](mockups/two.png)`],
      ["1"], // 仅序号 1——序号 2 被 promised 但未 verified
    );

    const a = acceptanceOf();
    const first = a.items.find((i) => i.text.includes("![a](mockups/one.png)"));
    const second = a.items.find((i) => i.text.includes("![b](mockups/two.png)"));
    expect(first, "both rows survive dedup (raw texts differ)").toBeTruthy();
    expect(second).toBeTruthy();

    // 在原始键下两个 obligation 是不同的，故 verified 的抬升、未 verified 的如实保持 ACTIVE。
    // 前驱的 stripped 键把它们变成一个 obligation 并把两者都抬升——把 QA 从未验证的工作报成
    // QA-verified。
    expect(first!.done).toBe(true);
    expect(first!.doneVia).toBe("qa-verdict");
    expect(second!.done).toBe(false);
    expect(second!.doneVia).toBeUndefined();

    // INV：恰好一个抬升，且 Review 恰好验证一个。
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBe(1);
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("AMB：两行 BYTE-IDENTICAL 的 authored contract ⇒ 1:1 闸门什么都不抬升（不抛错）", () => {
    // 真正歧义的情形——闸门的现实用途。两个相同 obligation、一个 verified：没有东西能区分
    // 裁决归属哪一行，故失败关闭。保持 ACTIVE 胜过抛硬币抬升。
    const body = "**D. Ambiguous obligation** — byte-identical authored line";
    contractVector([body, body], ["1"]);

    const a = acceptanceOf();
    // 两个相同 README 行去重为一个 acceptance 行……
    const rows = a.items.filter((i) => i.text === body);
    expect(rows).toHaveLength(1);
    // …但该键仍连到两个 obligation，故关联不是 1:1，拒绝抬升。
    expect(rows[0]!.done).toBe(false);
    expect(rows[0]!.doneVia).toBeUndefined();

    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    expect(lifted).toBe(0);
    expect(lifted).toBeLessThanOrEqual(reviewVerifiedCount());
  });

  it("INV：在冻结的六裁决夹具上，抬升计数等于 Review 的 verified 计数", () => {
    const a = acceptanceOf();
    const lifted = a.items.filter((i) => i.doneVia === "qa-verdict").length;
    const verified = reviewVerifiedCount();
    expect(lifted).toBe(6);
    expect(verified).toBe(6);
    expect(lifted).toBeLessThanOrEqual(verified);
  });

  // --- FS-1 · IO 护栏：仅在可能抬升时才读 proof/ ---

  /** 自上次 clear 以来，瞄准本 slice proof 目录的 readdirSync 调用次数
   *  （indexing 发生在 clear 之前——只计 project()）。
   *  限定于纯字符串签名（`readdirSync(dir)`）——即 readProofArtifacts 的确切调用形状——
   *  因为 projector 的 Docs 树（buildDocsTree）本就在每次 projection 时以
   *  `{withFileTypes: true}` 遍历整个 slice 目录（含 proof/）：那是 base 就存在的既有 IO，
   *  与 FS-1 所约束的 acceptance 并集正交（观测路由给 pm——同一 per-mission 扇出族）。 */
  function proofReaddirCount(): number {
    const mocked = fs.readdirSync as unknown as { mock: { calls: unknown[][] } };
    return mocked.mock.calls.filter(
      (args) => String(args[0]).endsWith(join(SLICE, "proof")) && args[1] === undefined,
    ).length;
  }

  function clearReaddirRecord(): void {
    (fs.readdirSync as unknown as { mockClear: () => void }).mockClear();
  }

  it("FS-1a：任何来源都无 contract 的 slice 对 proof/ 执行零次 readdir", () => {
    // 2026-08-24 重新钉住（桌面裁定 row 9acb0aae）：仅删 PRD 不再移除 contract（README 在
    // one-home 法则下 authored 一个）——真正缺失剥除每个来源，零 readdir 保证恰在那里成立。
    rmSync(fileOf("IMPLEMENTATION-PRD.md"));
    editFile("README.md", (c) => c.replace("## Proof contract", "## Notes"));
    indexer.get(SLICE); // 在 clear 前先索引——只有 project() 在被测
    clearReaddirRecord();
    acceptanceOf();
    expect(proofReaddirCount()).toBe(0);
  });

  it("FS-1b：全部勾选的 contract 对 proof/ 执行零次 readdir（并集只能抬升）", () => {
    editFile("README.md", (c) => {
      const contractStart = c.indexOf("## Proof contract");
      const head = c.slice(0, contractStart);
      const tail = c.slice(contractStart).replace(/- \[ \] \*\*/g, "- [x] **");
      return head + tail;
    });
    indexer.get(SLICE);
    clearReaddirRecord();
    const a = acceptanceOf();
    expect(a.doneItems).toBe(13);
    expect(proofReaddirCount()).toBe(0);
  });

  it("FS-1c：未勾选的 authored contract 每次 projection 恰好读 proof/ 一次", () => {
    indexer.get(SLICE);
    clearReaddirRecord();
    acceptanceOf();
    expect(proofReaddirCount()).toBe(1);
  });

  // qitem-render-driver B——共享 logical-checkbox 关系的 DESYNC 护栏。VM-006 抬升经 textKey
  //（trim+lowercase）把 Review 的 promised rawText 与 Progress 的 acceptance 行文本连接。如今
  // 两侧都在 continuation 边界截断，故只是碰巧一致；修复后两侧都必须连接 continuation 且仍一致。
  //
  // 断言瞄准被精确修改的那个 obligation（而非无关行也可能满足的聚合计数）：该行必须携带
  // 连接后的 continuation，且仍经 qa-verdict 抬升。今日为 RED（无连接）；若只有一个 parser
  // 学会 continuation，会再次 RED——即 silent-desync 类别。
  it("B desync 护栏：被续接的 obligation 携带其连接文本，且仍经 qa-verdict 抬升", () => {
    const CONT = "and the label survives a reload";
    const addContinuation = (c: string) =>
      c.replace(
        /^(- \[[ xX]\] \*\*1\. Shared card label\*\*.*)$/m,
        (line) => `${line}\n      ${CONT}`,
      );
    editFile("IMPLEMENTATION-PRD.md", addContinuation);
    editFile("README.md", addContinuation);

    const a = acceptanceOf();
    // 按 authored 头部定位精确的那个 obligation，然后要求连接。
    const row = a.items.find((i) => i.text.includes("Shared card label"));
    expect(row, "shared-card-label obligation 必须存在").toBeTruthy();
    expect(row!.text, "被续接的 obligation 必须携带其连接后的 continuation").toContain(CONT);
    // …同一行仍必须被 QA 裁决抬升。
    expect(row!.done, "被续接的 obligation 必须仍被抬升").toBe(true);
    expect(row!.doneVia, "由记录的 QA 裁决抬升，而非勾选 checkbox").toBe("qa-verdict");
    // 保留全局天花板（pm FR-2 不变量 2）。
    expect(a.items.filter((i) => i.doneVia === "qa-verdict").length).toBeLessThanOrEqual(reviewVerifiedCount());
  });

});
