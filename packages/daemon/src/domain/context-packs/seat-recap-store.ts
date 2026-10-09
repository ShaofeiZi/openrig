// OPR.0.5.3.5 微型需求 7（Q2 + Q2 修订 1）——席位回顾存储。
//
// authored recap：由离任 occupant 在 boundary 编写的带理由决策，扩展已交付的 from-record boot
// recap 名称（Q2 unify-what-exists 裁定——predecessor-recap-resolver.ts 仍是 transcript-derived
// sibling）。与 LEARNED 一样归属于 seat（Q2-Amendment 1(a)：recap 是 position knowledge，
// 从构造上不可共享——归属于 library 的 recap 会把 position knowledge 放上 portable shelf）。
// RETENTION（1(b)）：superseded-chain versioning——最新 recap 为 RECAP.md，predecessor 在 seat
// 目录下的 recap-superseded/ 中逐字节保留，由 seat-directory lifecycle 清理，绝不由 library
// curation 清理；不创建 librarian job。
//
// 两个刻意区分的 validation 层级：
// - ADDRESSABILITY 是写入时唯一 hard gate：recap 按 address（seat:RECAP.md#...）组合，因此
//   无法寻址的 recap（重复 header path、未闭合 fence）会在下游使每个 handover profile 延迟且
//   静默地失败。这是结构检查，不检查 prose shape。
// - AUTHORING CONTRACT 只对其可检查子集做 advisory 校验：finding 标记供 review，绝不阻塞
//   boundary（D2 pattern）。contract 的语义部分（temporal order、derived-values-as-commands）
//   无法机械检查，也不假装已经检查。

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateMarkdownAddressability, parseMarkdownSections } from "../markdown-address.js";
import { parseSessionName } from "../session-name.js";

export const RECAP_FILENAME = "RECAP.md";
const CHAIN_DIRNAME = "recap-superseded";

export class RecapWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecapWriteError";
  }
}

export interface RecapChainEntry {
  /** 已取代 recap 的绝对路径。 */
  path: string;
  /** 编码在 filename 中的 supersession timestamp（ms epoch）。 */
  supersededAtMs: number;
  /** 同毫秒 disambiguator（裸名称为 1，带 -N suffix 时为 2+）。 */
  sequence: number;
}

/** 写入 seat 当前 recap，将现有 recap 放入 superseded chain。gate 只检查 ADDRESSABILITY，
 *  从不检查 prose shape。 */
export function writeSeatRecap(opts: { seatDir: string; content: string; now?: () => number }): void {
  const findings = validateMarkdownAddressability(opts.content);
  if (findings.length > 0) {
    throw new RecapWriteError(
      `recap 无法寻址，因而永远无法组合（seat:${RECAP_FILENAME}#... 会使每个 handover profile ` +
        `失败）：${findings.map((f) => f.kind === "unterminated-fence" ? `第 ${f.line} 行的 fence 未闭合` : `${f.kind} '${"headerPath" in f ? f.headerPath : ""}'`).join("；")}。` +
        `请修复结构（重复 header path / 未闭合 fence）；prose shape 不受 gate 限制。`,
    );
  }
  const now = opts.now ?? Date.now;
  const current = join(opts.seatDir, RECAP_FILENAME);
  if (existsSync(current)) {
    const chainDir = join(opts.seatDir, CHAIN_DIRNAME);
    mkdirSync(chainDir, { recursive: true });
    // 防碰撞命名（r1 F1）：renameSync 到现有 path 会替换它，因此同一毫秒内两次 supersession
    // 曾会静默销毁 predecessor——颠倒 retention contract。counter suffix 用于消除歧义：
    // 不丢失内容，boundary write 仍成功（两方面都优于抛错）。`now` 可注入，因此程序化 caller
    // 会确定性碰撞，而非偶发碰撞。
    const stamp = String(now()).padStart(15, "0");
    let target = join(chainDir, `RECAP-${stamp}.md`);
    for (let counter = 2; existsSync(target); counter++) {
      target = join(chainDir, `RECAP-${stamp}-${counter}.md`);
    }
    renameSync(current, target);
  }
  writeFileSync(current, opts.content);
}

/** superseded chain，最旧项优先。从未取代 recap 时为空。 */
export function listRecapChain(seatDir: string): RecapChainEntry[] {
  const chainDir = join(seatDir, CHAIN_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(chainDir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = name.match(/^RECAP-(\d+)(?:-(\d+))?\.md$/);
      return m
        ? { path: join(chainDir, name), supersededAtMs: Number(m[1]), sequence: m[2] ? Number(m[2]) : 1 }
        : null;
    })
    .filter((e): e is RecapChainEntry => e !== null)
    .sort((a, b) => a.supersededAtMs - b.supersededAtMs || a.sequence - b.sequence);
}

export type RecapContractFinding =
  | { kind: "no-decisions-section" }
  | { kind: "nonstandard-unverified-marker"; line: number };

/** authoring contract 的可检查子集（Q2）：decisions-with-rationale 有一个结构 proxy
 *  （存在以 decisions 为标题的 section）；UNVERIFIED marker 使用 canonical grammar
 *  （大写 `UNVERIFIED:`），必须始终可被找到——变体 marker 会掩盖它本应标记的事实。
 *  advisory：返回 finding，绝不抛错。 */
export function validateRecapContract(content: string): RecapContractFinding[] {
  const findings: RecapContractFinding[] = [];
  const sections = parseMarkdownSections(content);
  const hasDecisions = sections.some((s) => s.headerPath[s.headerPath.length - 1]!.includes("decision"));
  if (!hasDecisions) findings.push({ kind: "no-decisions-section" });
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/unverified/i.test(line) && !line.includes("UNVERIFIED:")) {
      findings.push({ kind: "nonstandard-unverified-marker", line: i });
    }
  }
  return findings;
}

/** 构建后续（r1 裁定 bb00e850；行 17015088）——已编写回顾指针
 *  resolution，只归于此处并靠近其读取的 store；通过 canonical parseSessionName（按第一个 @
 *  拆分，即已记录的 greedy-rig 裁定）解析 seat ref——绝不引入第二个 parser。保留 safety floor：
 *  无法解析或非 canonical ref 会带具名 reason 失败并说明尝试内容；模糊匹配另一个 seat 的目录会把
 *  不同 occupant 的决策交给 successor，这比如实缺失更糟。 */
export function resolveAuthoredRecapPointer(
  seatRef: string,
  topologyRoot: string,
): { address: string; chainLength: number } | { absentReason: string } {
  const parsed = parseSessionName(seatRef);
  if (parsed.kind !== "canonical") {
    return { absentReason: `seat ref '${seatRef}' 无法解析为 canonical <seat>@<rig>（parse verdict：${parsed.kind}）——未解析 authored recap，也绝不猜测` };
  }
  const seatDir = join(topologyRoot, "rigs", parsed.rig, "seats", parsed.member);
  if (!existsSync(join(seatDir, RECAP_FILENAME))) {
    return { absentReason: `seat tree（${seatDir}）中没有 ${RECAP_FILENAME}——predecessor 从未写入` };
  }
  return { address: `seat:${RECAP_FILENAME}`, chainLength: listRecapChain(seatDir).length };
}
