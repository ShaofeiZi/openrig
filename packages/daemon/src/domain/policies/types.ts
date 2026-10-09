// PL-004 阶段 C：共享策略契约类型。
//
// 每个 watchdog 策略实现 `evaluate(job)` 并返回 PolicyEvaluation。该过程为纯逻辑：
// 无副作用、不访问事件总线和 DB。watchdog-policy-engine 将 `action: send` 映射为
// 投递调用，通过 watchdog-history-log 记录有意义的结果，并发出对应 RigEvent。

export interface PolicyJob {
  jobId: string;
  policy: string;
  /**
   * POC 形状的目标对象。有 spec_yaml 顶层 `target:` 块时由其构造；否则回退为
   * `{session: registered targetSession}`。策略按 POC 约定访问 `job.target.session`。
   */
  target: { session: string };
  /** 可选的顶层消息覆盖（POC 模式：`job.message`）。 */
  message?: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds: number | null;
  scanIntervalSeconds: number | null;
  /** 从操作员提供的 spec_yaml 中解析出的 `context:` 块。 */
  context: Record<string, unknown>;
  lastEvaluationAt: string | null;
  lastFireAt: string | null;
  registeredBySession: string;
  registeredAt: string;
  watchedFilePath: string | null;
  thresholdBytes: number | null;
  requiresJobId: string | null;
  lastFiredGeneration: string | null;
  occupantGeneration: string | null;
  currentGenerationTranscriptPending: boolean;
  requiredReceiptSatisfied: boolean;
  requiredReceiptDeferred: boolean;
}

export type PolicyEvaluation =
  | {
      action: "send";
      target: { session: string };
      message: string;
      notes?: Record<string, unknown>;
      /**
       * OPR.0.5.8.1 S2——本次发送所对应条件的不透明回执，仅在投递真正成功时
       * 才由引擎持久化。
       *
       * 以“已经通知过”为由抑制发送的策略，必须在确有投递证据时记录该事实。初版在
       * 尝试投递前就在 evaluate() 内写入回执，导致一次瞬时传输失败就会抑制唤醒，
       * 直到被观察条件变化；这会用静默替代噪声，是更严重的失败。未设置此字段的策略
       * 不受影响。
       */
      conditionReceipt?: string;
    }
  | { action: "skip"; reason: string; notes?: Record<string, unknown> }
  | { action: "terminal"; reason: string; notes?: Record<string, unknown> };

export interface Policy {
  /** 与 watchdog_jobs.policy 枚举匹配的稳定标识符。 */
  readonly name: string;
  /**
   * 纯评估。除文件系统读取（artifact-pool 扫描）外不执行 I/O。仅在硬契约违规
   *（缺失必填 spec 字段）时抛错；可恢复条件（无可操作产物、近期已成功运行）
   * 必须返回 action=skip。
   */
  evaluate(job: PolicyJob): Promise<PolicyEvaluation>;
}
