// OPR.0.5.3.5 Atom 3——组合代数（已锁定规范，创始人细化）：
//
//   FRESH           = 基础遍历（标记 fresh 的 atom）
//   HANDOVER        = FRESH + 交接材料（标记 handover 的 atom）
//   POST-COMPACTION = fresh 的已标记子集 + 交接材料
//
// 每个 profile 都必须对 requires 闭包（子集 profile 也必须闭合，这是接入规则）；runtime 过滤按
// mini-req 3 执行：不能假定 claude 与 codex 丢失了相同维度，因此它们会从同一张图组合出不同
// profile。每个 piece 都通过 Atom-1 地址机制解析，并携带逐 piece 的来源标签
//（Q2 修订 1：组合按契约是多来源的——library / project tree / seat tree / mission tree；
// 每个组装 piece 都标明来源，调用方 resolver 决定类型，本模块负责标记）。预算在组合时评估；
// 超额时报告数量与按优先级排序的丢弃候选，组合本身绝不静默截断
//（mini-req 9；D2：预算只提示审查，绝不静默支配结果）。
//
// 与 manifest parser 一样，本模块按契约保持纯函数：文件文本通过调用方 readFile 传入，使同一套
// 代数既服务当前 library pack，也能在接线 atom 落地后服务已配置的 tree root
//（project/seat/mission 来源）。所有失败都必须明确点名 atom；组合会停止，而不是悄悄削薄遍历
//（Q1 理由）。

import type { ContextPackAtom, ContextPackProfile } from "./context-pack-types.js";
import { estimateTokensFromBytes } from "./token-estimate.js";
import { AddressResolutionError, parseAddress, resolveAddress } from "../markdown-address.js";

export class ProfileComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileComposeError";
  }
}

export type ComposeSituation = "fresh" | "handover" | "post-compaction";
export type ComposeRuntime = "claude" | "codex";
export type SourceKind = "library" | "project" | "seat" | "mission";

export interface ComposeInput {
  /** 唯一 atom 图；调用方可能从多个来源汇集而成。 */
  atoms: ContextPackAtom[];
  situation: ComposeSituation;
  runtime: ComposeRuntime;
  /** 以地址中 `#` 之前的 ref 为 key、失败时明确报错的文件读取器。 */
  readFile: (ref: string) => string;
  /** 当前 situation 的 token 预算（D2 目标）；省略表示不检查预算。 */
  budgetTokens?: number;
  /** 逐 atom 的来源标注（Q2 修订 1）；默认为 "library"。 */
  sourceKindFor?: (atom: ContextPackAtom) => SourceKind;
}

export interface ComposedPiece {
  atomId: string;
  address: string;
  sourceKind: SourceKind;
  order: number;
  priority: ContextPackAtom["priority"];
  /** 已解析文本：带地址时为目标完整区段（Q1 full-span 规则），否则为整个文件。 */
  text: string;
  estimatedTokens: number;
  /** 具名 install profile 才有，使扁平投递流仍携带应用前检查者看到的 phase 边界。 */
  phaseId?: string;
}

export interface ComposedProfilePhase {
  id: string;
  kind: "atoms" | "context";
  sources?: string[];
  pieces: ComposedPiece[];
  estimatedTokens: number;
}

export interface ComposedProfile {
  situation: ComposeSituation;
  runtime: ComposeRuntime;
  pieces: ComposedPiece[];
  totalEstimatedTokens: number;
  /** 仅在显式选择 manifest profile 时存在。 */
  profileId?: string;
  phases?: ComposedProfilePhase[];
  /** 仅预算触发时存在：它是一份报告，绝不是截断结果。 */
  budget?: {
    limitTokens: number;
    overageTokens: number;
    /** 优先丢弃候选，顺序为 optional、recommended、core；同一层级先列较大的 piece。 */
    dropCandidates: Array<{ atomId: string; priority: ContextPackAtom["priority"]; estimatedTokens: number }>;
  };
}

/** 按已锁定代数，返回为 profile 选择 atom 的 situation tag。 */
function selectionTags(situation: ComposeSituation): ComposeSituation[] {
  switch (situation) {
    case "fresh":
      return ["fresh"];
    case "handover":
      return ["fresh", "handover"];
    case "post-compaction":
      return ["post-compaction", "handover"];
  }
}

const DROP_ORDER: Record<ContextPackAtom["priority"], number> = { optional: 0, recommended: 1, core: 2 };

function resolvePieces(input: {
  atoms: ContextPackAtom[];
  readFile: (ref: string) => string;
  sourceKindFor?: (atom: ContextPackAtom) => SourceKind;
  phaseId?: string;
}): ComposedPiece[] {
  return input.atoms.map((a) => {
    const { ref, headerPath } = parseAddress(a.address);
    let fileText: string;
    try {
      fileText = input.readFile(ref);
    } catch (err) {
      throw new ProfileComposeError(`atom '${a.id}'（${a.address}）：来源文件 '${ref}' 不可读——${(err as Error).message}`);
    }
    let text: string;
    if (headerPath.length === 0) {
      text = fileText;
    } else {
      try {
        text = resolveAddress(fileText, headerPath).text;
      } catch (err) {
        if (err instanceof AddressResolutionError) {
          throw new ProfileComposeError(`atom '${a.id}' (${a.address}): ${err.message}`);
        }
        throw err;
      }
    }
    return {
      atomId: a.id,
      address: a.address,
      sourceKind: input.sourceKindFor?.(a) ?? "library",
      order: a.order,
      priority: a.priority,
      text,
      estimatedTokens: estimateTokensFromBytes(Buffer.byteLength(text, "utf-8")),
      ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
    };
  });
}

function budgetReport(pieces: ComposedPiece[], budgetTokens: number | undefined): ComposedProfile["budget"] {
  const totalEstimatedTokens = pieces.reduce((sum, piece) => sum + piece.estimatedTokens, 0);
  if (budgetTokens === undefined || totalEstimatedTokens <= budgetTokens) return undefined;
  return {
    limitTokens: budgetTokens,
    overageTokens: totalEstimatedTokens - budgetTokens,
    dropCandidates: [...pieces]
      .sort((x, y) => DROP_ORDER[x.priority] - DROP_ORDER[y.priority] || y.estimatedTokens - x.estimatedTokens || x.atomId.localeCompare(y.atomId))
      .map((piece) => ({ atomId: piece.atomId, priority: piece.priority, estimatedTokens: piece.estimatedTokens })),
  };
}

export function composeProfile(input: ComposeInput): ComposedProfile {
  const { atoms, situation, runtime, readFile, budgetTokens, sourceKindFor } = input;
  const byId = new Map(atoms.map((a) => [a.id, a]));

  // 1. 先按 situation tag 选择，再按 runtime 过滤；"any" atom 同时服务两种运行时。
  const tags = selectionTags(situation);
  const runtimeFits = (a: ContextPackAtom): boolean => a.runtime === "any" || a.runtime === runtime;
  const selected = new Map<string, ContextPackAtom>();
  for (const a of atoms) {
    if (!a.profileOnly && a.situations.some((s) => tags.includes(s)) && runtimeFits(a)) selected.set(a.id, a);
  }

  // 2. 对 requires 做闭包：即使 required atom 未带 tag，也必须加入 profile。
  //    若依赖存在但被 runtime 过滤排除，则该运行时对应的图已经损坏；必须明确失败，不能静默削薄遍历。
  const queue = [...selected.keys()];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const req of selected.get(id)?.requires ?? byId.get(id)?.requires ?? []) {
      if (selected.has(req)) continue;
      const dep = byId.get(req);
      if (!dep) {
        throw new ProfileComposeError(`atom '${id}' 依赖 '${req}'，但图中不存在该 atom——${situation} profile 无法闭合。`);
      }
      if (!runtimeFits(dep)) {
        throw new ProfileComposeError(
          `atom '${id}' 依赖 '${req}'，但 '${req}' 声明为 runtime=${dep.runtime}，本次组合目标为 runtime=${runtime}——` +
            `闭包会静默削薄 ${situation} 遍历；请修复图（重新标记 '${req}' 或删除该边）。`,
        );
      }
      selected.set(req, dep);
      queue.push(req);
    }
  }

  // 3. 对遍历稳定排序：先按 order，再按 id；吸收结果依赖此顺序。
  const walk = [...selected.values()].sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));

  // 4. 通过唯一地址机制解析每个 piece，并标记其来源。
  const pieces = resolvePieces({ atoms: walk, readFile, sourceKindFor });

  const totalEstimatedTokens = pieces.reduce((sum, p) => sum + p.estimatedTokens, 0);

  // 5. 生成预算报告（mini-req 9）：只标记、不支配结果，所有 piece 均保留。
  const budget = budgetReport(pieces, budgetTokens);

  return { situation, runtime, pieces, totalEstimatedTokens, ...(budget !== undefined ? { budget } : {}) };
}

/** 组合一个显式 manifest profile。Profile 只改变选择与顺序：每个 atom 仍通过同一来源图解析；
 * project/mission/seat/task atom 由路由从已配置根目录提供。 */
export function composeNamedProfile(input: ComposeInput & {
  profile: ContextPackProfile;
  contextAtoms: Partial<Record<"project" | "mission" | "seat" | "slice", ContextPackAtom[]>>;
}): ComposedProfile {
  const { profile, atoms, situation, runtime, readFile, sourceKindFor, budgetTokens, contextAtoms } = input;
  if (!profile.situations.includes(situation)) {
    throw new ProfileComposeError(`profile '${profile.id}' 不适用于 situation '${situation}'`);
  }
  if (!profile.runtimes.includes(runtime)) {
    throw new ProfileComposeError(`profile '${profile.id}' 不适用于 runtime '${runtime}'`);
  }

  const atomsById = new Map(atoms.map((atom) => [atom.id, atom]));
  const phases: ComposedProfilePhase[] = profile.phases.map((phase) => {
    let selected: ContextPackAtom[];
    let kind: ComposedProfilePhase["kind"];
    if (phase.atoms) {
      kind = "atoms";
      selected = phase.atoms.map((atomId) => {
        const atom = atomsById.get(atomId);
        if (!atom) throw new ProfileComposeError(`profile '${profile.id}' 的 phase '${phase.id}' 引用了缺失的 atom '${atomId}'`);
        return atom;
      });
    } else {
      kind = "context";
      selected = [];
      for (const source of phase.context ?? []) {
        const sourceAtoms = contextAtoms[source];
        if (!sourceAtoms || sourceAtoms.length === 0) {
          throw new ProfileComposeError(`profile '${profile.id}' 的 phase '${phase.id}' 需要 ${source} context，但调用方没有提供其精确选择`);
        }
        selected.push(...sourceAtoms);
      }
    }
    const pieces = resolvePieces({ atoms: selected, readFile, sourceKindFor, phaseId: phase.id });
    return {
      id: phase.id,
      kind,
      ...(phase.context ? { sources: [...phase.context] } : {}),
      pieces,
      estimatedTokens: pieces.reduce((sum, piece) => sum + piece.estimatedTokens, 0),
    };
  });
  const pieces = phases.flatMap((phase) => phase.pieces);
  const totalEstimatedTokens = pieces.reduce((sum, piece) => sum + piece.estimatedTokens, 0);
  const budget = budgetReport(pieces, budgetTokens);
  return {
    situation,
    runtime,
    profileId: profile.id,
    phases,
    pieces,
    totalEstimatedTokens,
    ...(budget !== undefined ? { budget } : {}),
  };
}
