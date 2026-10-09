// P34——枚举防护：事务内队列 writer 集合是封闭的。
//
// dev50-planner 于 17:57Z 裁定，dev50-guard 于 18:03Z 放行。
//
// 为何按调用点而非值索引。直观的表述——“每个能把终止状态传给
// updateWithinTransaction 的调用方都必须获准”——属于值跟踪属性，而值跟踪无法局部判定：
//     const s = cond ? "done" : "blocked";   updateWithinTransaction({ state: s })
// 上述写法以及赋值、循环和初始化器形式都会绕过它。review50-r2 正是用四种普通
// TypeScript 形态得到 violations=[]，证伪了 W2b rev-1 防护的这一属性。
//
// 因此，此防护只询问一个语法问题：该文件是否调用 updateWithinTransaction？这完全可判定，
// 且不会被状态值的计算方式绕过。
//
// 它有意过度近似。仅执行 park 的调用方也会列出，每个条目都指明所属情况。添加 writer 时，
// 过度近似只增加一行显式记录；欠近似会静默失败，而这正是该原子要封堵的缺陷类型。
// 新 writer 出现前，必须由人明确记录其用途。
//
// 此防护不声明什么。它是检查时防护，而非运行时强制。better-sqlite3 不公开 commit hook，
// 且每个 writer 拥有自己的 db.transaction，因此第四个 writer 可在运行时被修复，却无法
// 在那里被捕获。诚实的阶段声明必须始终是：“通过队列终止动词不可实现；第四个 writer
// 会在检查时触发防护失败；并非运行时强制。”绝不能只说“不可能”。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── REV 2（review-r2 HIGH-1）——粒度修复 ─────────────────────────────────────
// Rev 1 批准文件名并统计文件，粒度比约束对象更粗：在已批准文件内新增无防护调用不会改变
// 文件数，测试仍为绿色——防护恰好无法为其目标情况失败。它还用原始正则匹配整个文件，
// 所以提到该 primitive 的注释会抬高计数，而别名绑定则完全逃逸。
//
// Rev 2 约束调用点。每个获准条目声明文件可含多少调用点以及原因；新增、删除或移动任何
// 调用都会改变计数，并按名称失败。注释行不计，别名绑定计入，方法定义不算调用点。
//
// Rev 1 的计数本身也有错误，这就是证据：它匹配 `.updateWithinTransaction(` 时包含注释行，
// 报告 4/3/2，而真实代码是 4/2/2，queue-repository 为零（第 1711 行是定义）。会因一行
// 注释而测偏的防护，并未测量真正的约束。

/** 每个获准调用方属于哪种情况，以及可包含多少调用点。标签正是关键：添加 writer 意味着
 *  说明其用途，而非仅让检查器静默。 */
const SANCTIONED: Record<string, { sites: number; why: string }> = {
  "domain/mission-control/mission-control-write-contract.ts": {
    sites: 2,
    why: "P34 terminal close + successor create (route/handoff) at :160; the non-terminal resolve update at :415",
  },
  "domain/workflow-projector.ts": {
    sites: 4,
    why: "legacy terminal close + gate park; dependency-graph packet close + dependency-graph gate park (parallel successors remain in the same transaction)",
  },
  "domain/workflow-runtime.ts": {
    sites: 6,
    why: "entry-gate park; explicit abort closes every live packet; no-successor exception close; packet-addressed route close; route re-park; reconcileStuckExceptions closes only recovered overdue occurrences with no-follow-on (59d252f6; workflow-exception-stuck.test.ts)",
  },
};

// 有意不列出 domain/queue-repository.ts。它定义 updateWithinTransaction，并通过私有的
// updateInTransactionalContext 到达自身写入路径——它是定义方而非调用方，因此有零个调用点。
// Rev 1 曾将其列出，并被计数断言捕获。如果仓库将来在自身调用该 primitive，那就是新调用点，
// 本防护要求明确记录。

const SRC = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Corpus {
  path: string;
  content: string;
}

interface GuardResult {
  violations: string[];
  /** 检查的调用点总数——不是文件数。rev-1 缺陷统计的是更粗单位，无法发现已统计文件内
   *  新增的调用点。 */
  examined: number;
  vacuous: boolean;
}

/** 此行是否仅含注释？有意采用低成本逐行判断：编写 rev 2 时，整文件正则剥离曾静默吞掉
 *  一次真实调用。 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** 单个源文件中该 primitive 的调用点。
 *  计入：  `x.updateWithinTransaction(`      ——普通调用
 *           `const { updateWithinTransaction }` / `= obj.updateWithinTransaction;`
 *                                             ——别名绑定，rev 1 完全遗漏，后续可调用它
 *  排除：注释行及方法声明本身。 */
export function countCallSites(content: string): number {
  let n = 0;
  for (const line of content.split("\n")) {
    if (isCommentLine(line)) continue;
    if (/^\s*updateWithinTransaction\s*\(/.test(line)) continue; // 方法声明。
    for (const _ of line.matchAll(/\.updateWithinTransaction\s*\(/g)) n += 1;
    // 别名绑定：标识符出现时并未立即在 receiver 上调用——它被解构或捕获到变量中，
    // 以供后续调用。
    if (/(?:\{[^}]*\bupdateWithinTransaction\b[^}]*\}\s*=)|(?:=\s*[\w.]*\.?updateWithinTransaction\s*[;,)])/.test(line)) {
      n += 1;
    }
  }
  return n;
}

/** 防护：作用于 corpus 的纯函数，因此无需向 src/ 添加违规 writer 即可演示其触发。 */
export function checkCallSites(
  corpus: Corpus[],
  sanctioned: Record<string, { sites: number; why: string }>,
): GuardResult {
  const violations: string[] = [];
  let examined = 0;
  for (const { path, content } of corpus) {
    const sites = countCallSites(content);
    if (sites === 0) {
      // 已不含任何调用点的获准条目属于列表腐化——允许列表会静默过度放行一个已不再是
      // writer 的文件。
      if (path in sanctioned) violations.push(`stale-entry:${path} (sanctioned for ${sanctioned[path]!.sites}, holds 0)`);
      continue;
    }
    examined += sites;
    const entry = sanctioned[path];
    if (!entry) {
      violations.push(`unsanctioned-file:${path} (${sites} call site${sites === 1 ? "" : "s"})`);
    } else if (entry.sites !== sites) {
      // REV-1 缺口：文件粒度防护无法发现这种情况。
      violations.push(`count-mismatch:${path} (sanctioned ${entry.sites}, found ${sites})`);
    }
  }
  return { violations, examined, vacuous: examined === 0 };
}

function realCorpus(): Corpus[] {
  return walk(SRC).map((full) => ({
    path: full.slice(SRC.length + 1).split("\\").join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

const TOTAL_SITES = Object.values(SANCTIONED).reduce((n, e) => n + e.sites, 0);

/** Rev 1 语义，仅保留为负向对照：批准文件名并统计文件。review-r2 HIGH-1 指出，
 *  在已获准文件中添加调用不会使其失败。下方测试通过实际运行证明这一点。 */
function checkFileGranular(corpus: Corpus[]): { violations: string[]; examined: number } {
  const violations: string[] = [];
  let examined = 0;
  for (const { path, content } of corpus) {
    if (!/\.updateWithinTransaction\s*\(/.test(content)) continue;
    examined += 1;
    if (!(path in SANCTIONED)) violations.push(path);
  }
  return { violations, examined };
}

/** 在已获准文件中插入一个额外调用的 corpus——正是 rev 1 无法发现的形态。 */
function corpusWithExtraCallInSanctionedFile(): Corpus[] {
  const corpus = realCorpus();
  const target = corpus.find((c) => c.path === "domain/workflow-projector.ts");
  if (!target) throw new Error("fixture precondition failed: sanctioned file not in corpus");
  return corpus.map((c) =>
    c === target
      ? {
          ...c,
          content:
            c.content +
            `\nfunction smuggledWriter(q: any, id: string) { q.updateWithinTransaction({ qitemId: id, state: "done" }); }\n`,
        }
      : c,
  );
}

describe("P34 RED 3——枚举防护（rev 2：调用点粒度）", () => {
  it("实时 corpus 按调用点与获准集合精确匹配", () => {
    const result = checkCallSites(realCorpus(), SANCTIONED);
    expect(result.violations).toEqual([]);
    // 统计调用点而非文件：3 个文件中共 12 个调用点。
    expect(result.examined).toBe(TOTAL_SITES);
    expect(result.examined).toBe(12);
    expect(result.vacuous).toBe(false);
  });

  it("HIGH-1：在已获准文件内新增调用时按名称触发", () => {
    const result = checkCallSites(corpusWithExtraCallInSanctionedFile(), SANCTIONED);
    expect(result.violations).toEqual([
      "count-mismatch:domain/workflow-projector.ts (sanctioned 4, found 5)",
    ]);
  });

  it("HIGH-1 负向对照：REV-1 文件粒度防护漏掉同一调用", () => {
    // 禁用细粒度、恢复 rev 1 语义后，观察目标违规未被捕获，才能让修复成为证据而非口头
    // 断言。从未观察到失败的对照不构成证据。
    const mutated = corpusWithExtraCallInSanctionedFile();
    expect(checkFileGranular(mutated).violations).toEqual([]); // rev 1：静默。
    expect(checkCallSites(mutated, SANCTIONED).violations).toHaveLength(1); // rev 2：明确失败。
  });

  it("新文件中出现状态值经计算的模拟第四个 writer 时触发", () => {
    const corpus = [
      ...realCorpus(),
      {
        path: "domain/rogue-writer.ts",
        content: `
          export class RogueWriter {
            close(id: string) {
              const state = Math.random() > 0.5 ? "done" : "blocked";
              this.queueRepo.updateWithinTransaction({ qitemId: id, state });
              this.queueRepo.createWithinTransaction({ body: "successor" });
            }
          }
        `,
      },
    ];
    // 状态值的计算方式与绕过 W2b rev-1 防护的方式完全相同。
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/rogue-writer.ts (1 call site)",
    ]);
  });

  it("统计 rev 1 完全遗漏的别名绑定", () => {
    const aliased = [
      {
        path: "domain/aliaser.ts",
        content: `const { updateWithinTransaction } = queueRepo;\nupdateWithinTransaction({ state: "done" });`,
      },
    ];
    expect(checkCallSites(aliased, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/aliaser.ts (1 call site)",
    ]);
  });

  it("不统计注释中的提及——文档引用不是调用点", () => {
    const corpus = realCorpus().map((c) =>
      c.path === "domain/workflow-projector.ts"
        ? { ...c, content: c.content + "\n// see QueueRepository.updateWithinTransaction for the contract\n" }
        : c,
    );
    // Rev 1 正是以这种方式抬高了计数。
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([]);
  });

  it("列表腐化时触发——获准文件已不再调用该 primitive", () => {
    const corpus = realCorpus().map((c) =>
      c.path === "domain/workflow-projector.ts"
        ? { ...c, content: c.content.split(".updateWithinTransaction(").join(".somethingElse(") }
        : c,
    );
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "stale-entry:domain/workflow-projector.ts (sanctioned for 4, holds 0)",
    ]);
  });

  it("相近文件名不会继承批准——允许列表按路径生效", () => {
    const corpus = [
      {
        path: "domain/workflow-projector-v2.ts",
        content: `this.queueRepo.updateWithinTransaction({ state: "done" });`,
      },
    ];
    expect(checkCallSites(corpus, SANCTIONED).violations).toEqual([
      "unsanctioned-file:domain/workflow-projector-v2.ts (1 call site)",
    ]);
  });
});

describe("P34 RED 5——已知负向用例：未检查任何内容的防护必须失败", () => {
  it("空 corpus 报告为空检查，而非干净通过", () => {
    const result = checkCallSites([], SANCTIONED);
    expect(result.violations).toEqual([]);
    expect(result.vacuous).toBe(true);
  });

  it("文件存在但均未调用该 primitive 时报告为空检查", () => {
    expect(
      checkCallSites([{ path: "domain/unrelated.ts", content: "export const x = 1;" }], SANCTIONED).vacuous,
    ).toBe(true);
  });

  it("实时运行不为空检查，且检查了预期数量的调用点", () => {
    const live = checkCallSites(realCorpus(), SANCTIONED);
    expect(live.vacuous).toBe(false);
    expect(live.examined).toBe(12);
  });
});
