import type { PsEntry } from "./ps-projection.js";
import type { Rig } from "./types.js";
import type { SearchResult, ChatSearchResult, SeatSearchResult, SeatHit, SessionSearchResult } from "./history-query.js";
import type { RigWithRelations } from "./types.js";
import type { WhoamiResult } from "./whoami-service.js";

export type { ChatSearchResult };

export interface AskDeps {
  psProjectionService: { getEntries(): PsEntry[] };
  rigRepo: { findRigsByName(name: string): Rig[]; getRig(rigId: string): RigWithRelations | null };
  historyQuery: {
    search(rigName: string, question: string): Promise<SearchResult>;
    searchChat(rigId: string, question: string): ChatSearchResult[];
    searchSeat(rigName: string, seatSessionName: string, question: string): Promise<SeatSearchResult>;
    searchSession(sessionToken: string, question: string): Promise<SessionSearchResult>;
  };
  transcriptsEnabled: boolean;
  whoamiService?: { resolve(query: { nodeId?: string; sessionName?: string }): WhoamiResult | null };
}

export interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

export interface AskSeatEvidence {
  name: string;
  generations: number;
  hits: SeatHit[];
  degraded?: { reason: string; message: string };
  advisory?: string;
}

export interface AskSessionEvidence {
  token: string;
  found: boolean;
  path?: string;
  excerpts: string[];
  degraded?: { reason: string; message: string };
  advisory?: string;
}

export interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  /** L1 seat-scoped evidence——仅在指定 seat 时存在。 */
  seat?: AskSeatEvidence;
  /** L2 session-scoped evidence——仅在指定 session token 时存在。 */
  session?: AskSessionEvidence;
  insufficient: boolean;
  guidance?: string;
}

interface StructuredAnswer {
  excerpts: string[];
  insufficient: boolean;
  guidance?: string;
}

export class AskService {
  private readonly deps: AskDeps;

  constructor(deps: AskDeps) {
    this.deps = deps;
  }

  async ask(rigName: string, question: string, context?: { nodeId?: string; sessionName?: string; seat?: string; session?: string }): Promise<AskResult> {
    // 解析工作组
    const rigs = this.deps.rigRepo.findRigsByName(rigName);

    if (rigs.length === 0) {
      return {
        question,
        rig: null,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: `未找到工作组 '${rigName}'。请使用 zrig ps 列出工作组。`,
      };
    }

    if (rigs.length > 1) {
      return {
        question,
        rig: null,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: `工作组 '${rigName}' 有歧义——${rigs.length} 个工作组使用该名称。请移除重复项或使用唯一名称。`,
      };
    }

    // 获取 topology 信息
    const entries = this.deps.psProjectionService.getEntries();
    const psEntry = entries.find((e) => e.name === rigName);
    const rigInfo: AskRigInfo = psEntry
      ? { name: psEntry.name, status: psEntry.status, nodeCount: psEntry.nodeCount, runningCount: psEntry.runningCount, uptime: psEntry.uptime }
      : { name: rigName, status: "unknown", nodeCount: 0, runningCount: 0, uptime: null };

    // L2——session-scoped archaeology：显式 session token 会搜索该 session 的 provider JSONL
    //（只读，不是 zrig transcript，因此不受 transcriptsEnabled 限制）。honest-degraded
    // 通过 guidance 呈现。
    if (context?.session) {
      const r = await this.deps.historyQuery.searchSession(context.session, question);
      let guidance: string | undefined;
      if (r.degraded) {
        guidance = r.degraded.message;
      } else if (r.found && r.insufficient) {
        guidance = `session '${context.session}' 中没有匹配内容。请尝试其他搜索词。`;
      }
      if (r.advisory) {
        guidance = guidance ? `${r.advisory}\n${guidance}` : r.advisory;
      }
      return {
        question,
        rig: rigInfo,
        evidence: { backend: r.backend, excerpts: r.excerpts },
        session: {
          token: r.token,
          found: r.found,
          path: r.path,
          excerpts: r.excerpts,
          degraded: r.degraded,
          advisory: r.advisory,
        },
        insufficient: r.insufficient,
        guidance,
      };
    }

    // L1——seat-scoped archaeology：显式 seat address 会跨所有 generation 搜索一个 seat 的
    // transcript（绝不执行 whole-rig grep，也不走 structured peer 路径）。honest-degraded
    // 通过 guidance 呈现。
    if (context?.seat) {
      if (!this.deps.transcriptsEnabled) {
        return {
          question,
          rig: rigInfo,
          evidence: { backend: "read", excerpts: [] },
          insufficient: true,
          guidance: "Transcript 已禁用。请使用 zrig config set transcripts.enabled true 启用。",
        };
      }
      const seatResult = await this.deps.historyQuery.searchSeat(rigName, context.seat, question);
      const excerpts = seatResult.hits.map((h) => `[gen ${h.generation}] ${h.text}`);
      let guidance: string | undefined;
      if (seatResult.degraded) {
        guidance = seatResult.degraded.message;
      } else if (seatResult.insufficient) {
        guidance = `seat '${context.seat}' 的 ${seatResult.generations} 个 generation 中没有匹配 evidence。请尝试其他搜索词。`;
      }
      if (seatResult.advisory) {
        guidance = guidance ? `${seatResult.advisory}\n${guidance}` : seatResult.advisory;
      }
      return {
        question,
        rig: rigInfo,
        evidence: { backend: seatResult.backend, excerpts },
        seat: {
          name: seatResult.seat,
          generations: seatResult.generations,
          hits: seatResult.hits,
          degraded: seatResult.degraded,
          advisory: seatResult.advisory,
        },
        insufficient: seatResult.insufficient,
        guidance,
      };
    }

    const structured = this.answerStructuredQuestion(rigs[0]!.id, rigName, question, context);
    if (structured) {
      return {
        question,
        rig: rigInfo,
        evidence: {
          backend: "structured",
          excerpts: structured.excerpts,
        },
        insufficient: structured.insufficient,
        guidance: structured.guidance,
      };
    }

    // 检查 transcript 是否启用
    if (!this.deps.transcriptsEnabled) {
      return {
        question,
        rig: rigInfo,
        evidence: { backend: "rg", excerpts: [] },
        insufficient: true,
        guidance: "Transcript 已禁用。请使用 zrig config set transcripts.enabled true 启用。",
      };
    }

    // 搜索 transcript
    const searchResult = await this.deps.historyQuery.search(rigName, question);

    // 通过共享 history-query seam 搜索 chat message
    let chatExcerpts: string[] | undefined;
    const rig = rigs[0]!;
    const chatResults = this.deps.historyQuery.searchChat(rig.id, question);
    if (chatResults.length > 0) {
      chatExcerpts = chatResults.map((r) => `[${r.sender}] ${r.body}`);
    }

    let guidance: string | undefined;
    const hasChatEvidence = chatExcerpts && chatExcerpts.length > 0;
    const isInsufficient = searchResult.insufficient && !hasChatEvidence;

    if (isInsufficient) {
      if (searchResult.noTranscriptDir) {
        guidance = `工作组 '${rigName}' 没有 transcript 目录。下次执行 zrig up 时会自动开始记录 transcript。`;
      } else if (searchResult.error) {
        // backend 失败
        guidance = searchResult.error;
      } else if (searchResult.backend === "none") {
        // 未使用 backend（keyword 为空）
        guidance = "无法从问题中提取有用的关键词。请尝试更具体的问题。";
      } else {
        // 已执行搜索但未找到匹配项
        guidance = "未找到匹配的 transcript evidence。请尝试其他搜索词。";
      }
    }

    return {
      question,
      rig: rigInfo,
      evidence: {
        backend: searchResult.backend,
        excerpts: searchResult.excerpts,
        chatExcerpts,
      },
      insufficient: isInsufficient,
      guidance,
    };
  }

  private answerStructuredQuestion(
    rigId: string,
    rigName: string,
    question: string,
    context?: { nodeId?: string; sessionName?: string },
  ): StructuredAnswer | null {
    const normalized = question.trim().toLowerCase();
    if (!normalized) return null;

    if (this.looksLikePeerQuestion(normalized)) {
      const identity = this.resolveIdentity(context);
      if (identity && identity.identity.rigId === rigId) {
        return {
          excerpts: identity.peers.map((peer) => this.formatPeerLine(peer.logicalId, peer.sessionName, peer.runtime, peer.podNamespace)),
          insufficient: false,
        };
      }
      return {
        excerpts: [],
        insufficient: true,
        guidance: "无法为 peer-relative 问题确定当前 node identity。请从目标 session 运行 zrig whoami --json，或从已附加的 managed node 重试。",
      };
    }

    return null;
  }

  private resolveIdentity(context?: { nodeId?: string; sessionName?: string }): WhoamiResult | null {
    if (!context?.nodeId && !context?.sessionName) return null;
    return this.deps.whoamiService?.resolve(context) ?? null;
  }

  private looksLikePeerQuestion(question: string): boolean {
    return /(^|\b)(who are my peers|who are the peers|list peers|show peers|who is in (this|the) rig|list nodes|show nodes)(\b|$)/.test(question);
  }

  private formatPeerLine(
    logicalId: string,
    sessionName: string | null,
    runtime: string,
    podNamespace: string | null,
  ): string {
    return `${logicalId}  会话=${sessionName ?? "未绑定"}  运行时=${runtime}  Pod=${podNamespace ?? "—"}`;
  }
}
