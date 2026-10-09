import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ScannedPane } from "./tmux-discovery-scanner.js";
import type { RuntimeHint, Confidence } from "./discovery-types.js";

/** 指纹识别期间收集的证据。 */
export interface FingerprintEvidence {
  layerUsed: number;
  cmuxSignal?: { runtime: string; pid: number };
  processSignal?: { command: string; matched: string };
  paneContentSignal?: { pattern: string; matchedLine: string };
  configSignal?: { claudeDir: boolean; agentsDir: boolean };
}

/** 单个 pane 的指纹识别结果。 */
export interface FingerprintResult {
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidence: FingerprintEvidence;
}

const SHELL_NAMES = new Set(["bash", "zsh", "fish", "sh", "dash", "tcsh", "csh"]);

const CLAUDE_PROCESS_PATTERNS = ["claude", "claude-code"];
const CODEX_PROCESS_PATTERNS = ["codex"];

const CLAUDE_PANE_PATTERNS = [
  { label: "Claude Code", test: (line: string) => /^\s*Claude Code\b/i.test(line) },
  { label: "claude>", test: (line: string) => /^\s*claude>\s*/i.test(line) },
  { label: "╭─ Claude", test: (line: string) => /^\s*╭─ Claude\b/i.test(line) },
];

const CODEX_PANE_PATTERNS = [
  { label: "Codex CLI", test: (line: string) => /^\s*Codex CLI\b/i.test(line) },
  { label: "codex>", test: (line: string) => /^\s*codex>\s*/i.test(line) },
  { label: "╭─ Codex", test: (line: string) => /^\s*╭─ Codex\b/i.test(line) },
];

/**
 * 四层运行时检测流水线。
 * 第 0 层：cmux 智能体 PID（最高置信度）
 * 第 1 层：进程树/活动命令（高）
 * 第 2 层：pane 内容启发式判断（中）
 * 第 3 层：CWD/配置上下文（中低，仅用于增强）
 */
export class SessionFingerprinter {
  private cmux: CmuxAdapter;
  private tmux: TmuxAdapter;
  private fsExists: (path: string) => boolean;
  private cachedAgentPIDs: Map<number, { runtime: string; pid: number }> | null = null;

  constructor(deps: { cmuxAdapter: CmuxAdapter; tmuxAdapter: TmuxAdapter; fsExists: (path: string) => boolean }) {
    this.cmux = deps.cmuxAdapter;
    this.tmux = deps.tmuxAdapter;
    this.fsExists = deps.fsExists;
  }

  /** 预取 cmux 智能体 PID 供批量使用；识别多个 pane 前调用。 */
  async refreshCmuxSignals(): Promise<void> {
    const result = await this.cmux.queryAgentPIDs();
    this.cachedAgentPIDs = result.ok ? result.data : null;
  }

  /** 识别一个已扫描 pane 的运行时指纹。 */
  async fingerprint(pane: ScannedPane): Promise<FingerprintResult> {
    const evidence: FingerprintEvidence = { layerUsed: -1 };

    // --- 第 0 层：cmux 智能体 PID ---
    if (this.cachedAgentPIDs === null) {
      await this.refreshCmuxSignals();
    }

    if (this.cachedAgentPIDs && pane.pid) {
      const cmuxMatch = this.cachedAgentPIDs.get(pane.pid);
      if (cmuxMatch) {
        evidence.layerUsed = 0;
        evidence.cmuxSignal = cmuxMatch;
        const hint = cmuxMatch.runtime.includes("claude") ? "claude-code" as RuntimeHint
          : cmuxMatch.runtime.includes("codex") ? "codex" as RuntimeHint
          : "unknown" as RuntimeHint;
        return { runtimeHint: hint, confidence: "highest", evidence };
      }
    }

    // --- 第 1 层：进程树/活动命令 ---
    if (pane.activeCommand) {
      const cmd = pane.activeCommand.toLowerCase();

      for (const pattern of CLAUDE_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "claude-code", confidence: "high", evidence };
        }
      }

      for (const pattern of CODEX_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "codex", confidence: "high", evidence };
        }
      }

      if (SHELL_NAMES.has(cmd)) {
        evidence.layerUsed = 1;
        evidence.processSignal = { command: pane.activeCommand, matched: "shell" };
        return { runtimeHint: "terminal", confidence: "high", evidence };
      }
    }

    // --- 第 2 层：pane 内容启发式判断 ---
    const content = await this.tmux.capturePaneContent(pane.tmuxPane);
    if (content) {
      const lines = content.split("\n");

      for (const line of lines) {
        for (const pattern of CLAUDE_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "claude-code", confidence: "medium", evidence };
          }
        }

        for (const pattern of CODEX_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "codex", confidence: "medium", evidence };
          }
        }
      }
    }

    // --- 第 3 层：CWD/配置上下文（仅增强）---
    let configBoost: RuntimeHint = "unknown";
    if (pane.cwd) {
      const hasClaudeDir = this.fsExists(`${pane.cwd}/.claude`);
      const hasAgentsDir = this.fsExists(`${pane.cwd}/.agents`);
      evidence.configSignal = { claudeDir: hasClaudeDir, agentsDir: hasAgentsDir };

      if (hasClaudeDir && !hasAgentsDir) configBoost = "claude-code";
      else if (hasAgentsDir && !hasClaudeDir) configBoost = "codex";
    }

    if (configBoost !== "unknown") {
      evidence.layerUsed = 3;
      return { runtimeHint: configBoost, confidence: "low", evidence };
    }

    // --- 没有信号 ---
    evidence.layerUsed = -1;
    return { runtimeHint: "unknown", confidence: "low", evidence };
  }
}
