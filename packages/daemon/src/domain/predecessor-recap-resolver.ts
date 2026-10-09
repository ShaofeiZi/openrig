import { parseJsonlExchanges, type JsonlExchange } from "./session-jsonl.js";
import type { PredecessorRecapResolver, PredecessorRecapResolution } from "./seat-handover-service.js";

/**
 * 席位交接启动回顾的生产解析器：解析离任席位的 provider 记录路径——claude 的
 * `transcript_path`（通过按会话名称索引的 sidecar）或 codex 的 `rollout_path`
 *（通过按离任 resume token 索引的 thread）——并把最后 N 次交流解析为有界的记录回顾。
 *
 * 该回顾是保留回滚内容的交接流程中永久的 claude-runtime 支线，而非临时措施：claude-code
 * 席位运行在 tmux alternate screen 中，不保留回滚缓冲区，因此继任窗格无法原生滚动查看前任会话。
 *（Codex 席位通过窗格内重新生成获得原生回滚内容，但仍会渲染回顾以方便阅读。）
 *
 * B16——claude 支线带竞态守卫，且每个 null 都有明确名称。sidecar 按会话名称索引，而切换时会跨代
 * 复用规范名称；因此已启动的继任者会覆盖解析器正要查询的 sidecar（线上缺陷表现为解析器读到
 * 继任者的新 sidecar，然后如实但静默地返回空结果）。两层防护：SERVICE 现在会在继任者启动前解析；
 * 当两者都存在时，本解析器还会用前任记录的 resume token 校验 sidecar 的 session_id。
 * 不匹配会得到明确指出冲突的 UNAVAILABLE 判定，绝不静默返回 null，也绝不返回他人的回顾。
 * 每种无回顾结果都返回 { unavailableReason }，使 packet 能说明原因；如实降级必须带标签，不能静默。
 *
 * 两个维度均有上限：最多 `maxExchanges` 次交流，每次内容最多 `maxCharsPerExchange` 个字符
 *（单个粘贴文件或长篇交流不能淹没继任窗格）；截断明确可见，并引导读者查看完整记录。
 * 纯函数加依赖注入，使运行时分支与守卫处理无需真实后台服务即可单元测试；startup 接入真实读取。
 */
const DEFAULT_MAX_EXCHANGES = 6;
const DEFAULT_MAX_CHARS_PER_EXCHANGE = 500;
const TRUNCATION_MARKER = "… [已截断；完整文本见前任记录]";

export interface PredecessorRecapResolverDeps {
  /** Claude：按名称索引的 sidecar 携带 `transcript_path` 与 `session_id`；读取同时返回两者，
   * 使调用方能核实该名称当前指向谁的记录。 */
  readClaudeRecord: (sessionName: string) => { transcriptPath: string | null; sessionId: string | null };
  /** Codex：归一化 usage 携带 `rollout_path`；根据 thread id（resume token）解析。 */
  readCodexTranscriptPath: (args: { threadId: string | null; sessionName: string }) => string | null;
  /** 按节点与会话名称查询离任会话的 resume token（Codex thread id；对 claude 行而言，
   * 它是前任的 session uuid，用于校验 sidecar 所有权）。 */
  lookupResumeToken: (nodeId: string, sessionName: string) => string | null;
  /** 可在测试中注入；默认使用真实 JSONL 解析器。 */
  parseExchanges?: (path: string, n: number) => JsonlExchange[];
  /** 有界回顾数量（默认 6）。 */
  maxExchanges?: number;
  /** 每次交流的字符上限（默认 500）；超出内容会明确显示为已截断。 */
  maxCharsPerExchange?: number;
}

function boundExchange(ex: JsonlExchange, maxChars: number): JsonlExchange {
  if (ex.content.length <= maxChars) return ex;
  return { role: ex.role, content: ex.content.slice(0, maxChars) + TRUNCATION_MARKER };
}

export function makePredecessorRecapResolver(deps: PredecessorRecapResolverDeps): PredecessorRecapResolver {
  const parse = deps.parseExchanges ?? parseJsonlExchanges;
  const max = deps.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const maxChars = deps.maxCharsPerExchange ?? DEFAULT_MAX_CHARS_PER_EXCHANGE;
  return ({ nodeId, runtime, sessionName }): PredecessorRecapResolution => {
    let path: string | null;
    if (runtime === "codex") {
      const threadId = deps.lookupResumeToken(nodeId, sessionName);
      if (!threadId) return { unavailableReason: "未记录离任 Codex 会话的 resume token" };
      path = deps.readCodexTranscriptPath({ threadId, sessionName });
      if (!path) return { unavailableReason: `未找到 Codex thread ${threadId} 的 rollout 记录` };
    } else {
      const record = deps.readClaudeRecord(sessionName);
      if (!record.transcriptPath) {
        return { unavailableReason: "按名称索引的 context sidecar 缺失，或未携带 transcript_path" };
      }
      // 所有权守卫：sidecar 必须属于前任，不能属于同名继任者。
      const predecessorToken = deps.lookupResumeToken(nodeId, sessionName);
      if (predecessorToken && record.sessionId && record.sessionId !== predecessorToken) {
        return {
          unavailableReason:
            `按名称索引的 sidecar 属于会话 ${record.sessionId.slice(0, 8)}…，而不是离任会话 ` +
            `${predecessorToken.slice(0, 8)}… (canonical-name reuse race — the record path would be the wrong tenure's)`,
        };
      }
      path = record.transcriptPath;
    }
    const recap = parse(path, max);
    if (recap.length === 0) {
      return { unavailableReason: `位于 ${path} 的前任记录未产生用户/助手交流（内容为空、不可读或过大而无法读取）` };
    }
    return { recap: recap.map((ex) => boundExchange(ex, maxChars)), recordPath: path };
  };
}
