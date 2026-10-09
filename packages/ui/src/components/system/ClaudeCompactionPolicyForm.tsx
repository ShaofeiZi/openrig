// Slice 27——Claude 自动压缩策略表单。
//
// 操作人员可配置的压缩前触发器：Claude 席位的上下文用量越过 `threshold_percent` 后，
// 后台服务 ContextMonitor 会先发送带固定包装的准备提示和可编辑的
// `pre_compact_instruction`，再在下一次合格观测时通过 SessionTransport 分派 `/compact`，
// 并可选地把 `compact_instruction` 作为斜杠命令参数。恢复阶段使用 `message_inline`、
// `message_file_path` 和可编辑的 `post_restore_audit_instruction`，外层由后台服务拥有的
// 信任框架包裹。
//
// 默认关闭，需显式启用。行内内容指向规范恢复技能；文件路径指向用户拥有的补充说明占位文件。

import { useState } from "react";
import type { FormEvent } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { useSettings, useSetSetting } from "../../hooks/useSettings.js";

type FormState = {
  enabled: boolean;
  thresholdPercent: string;
  preCompactInstruction: string;
  compactInstruction: string;
  messageInline: string;
  messageFilePath: string;
  postRestoreAuditInstruction: string;
};

const KEY_ENABLED = "policies.claude_compaction.enabled" as const;
const KEY_THRESHOLD = "policies.claude_compaction.threshold_percent" as const;
const KEY_PRE_COMPACT_INSTRUCTION = "policies.claude_compaction.pre_compact_instruction" as const;
const KEY_COMPACT_INSTRUCTION = "policies.claude_compaction.compact_instruction" as const;
const KEY_INLINE = "policies.claude_compaction.message_inline" as const;
const KEY_FILE_PATH = "policies.claude_compaction.message_file_path" as const;
const KEY_POST_RESTORE_AUDIT = "policies.claude_compaction.post_restore_audit_instruction" as const;

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function ClaudeCompactionPolicyForm() {
  const { data, isLoading, error } = useSettings();
  const setSetting = useSetSetting();

  if (!data) {
    return (
      <section
        data-testid="claude-compaction-policy-form"
        className="border border-outline-variant p-5 bg-surface-lowest/50"
      >
        <SectionHeader tone="muted">策略</SectionHeader>
        <h2 className="font-headline text-headline-sm font-bold tracking-tight uppercase text-on-surface mt-1">
          Claude 自动压缩
        </h2>
        {isLoading && (
          <p className="mt-4 text-sm text-on-surface-variant" data-testid="claude-compaction-policy-loading">
            正在加载当前设置…
          </p>
        )}
        {error && (
          <p className="mt-4 text-sm text-error" data-testid="claude-compaction-policy-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
      </section>
    );
  }

  return <PolicyFormBody data={data.settings} setSetting={setSetting} />;
}

interface PolicyFormBodyProps {
  data: Record<string, { value: unknown }>;
  setSetting: ReturnType<typeof useSetSetting>;
}

function PolicyFormBody({ data, setSetting }: PolicyFormBodyProps) {
  const [form, setForm] = useState<FormState>(() => ({
    enabled: coerceBoolean(data[KEY_ENABLED]?.value, false),
    thresholdPercent: String(coerceNumber(data[KEY_THRESHOLD]?.value, 80)),
    preCompactInstruction: coerceString(data[KEY_PRE_COMPACT_INSTRUCTION]?.value),
    compactInstruction: coerceString(data[KEY_COMPACT_INSTRUCTION]?.value),
    messageInline: coerceString(data[KEY_INLINE]?.value),
    messageFilePath: coerceString(data[KEY_FILE_PATH]?.value),
    postRestoreAuditInstruction: coerceString(data[KEY_POST_RESTORE_AUDIT]?.value),
  }));
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitOk(false);
    setSubmitError(null);
    const thresholdRaw = form.thresholdPercent.trim();
    const thresholdValue = Number(thresholdRaw);
    if (!/^\d+$/.test(thresholdRaw) || thresholdValue < 1 || thresholdValue > 100) {
      setThresholdError("阈值必须是 1 到 100 之间的整数。");
      return;
    }
    setThresholdError(null);

    const updates: Array<{ key: Parameters<typeof setSetting.mutateAsync>[0]["key"]; value: string }> = [
      { key: KEY_ENABLED, value: form.enabled ? "true" : "false" },
      { key: KEY_THRESHOLD, value: String(thresholdValue) },
      { key: KEY_PRE_COMPACT_INSTRUCTION, value: form.preCompactInstruction },
      { key: KEY_COMPACT_INSTRUCTION, value: form.compactInstruction },
      { key: KEY_INLINE, value: form.messageInline },
      { key: KEY_FILE_PATH, value: form.messageFilePath },
      { key: KEY_POST_RESTORE_AUDIT, value: form.postRestoreAuditInstruction },
    ];
    try {
      for (const update of updates) {
        await setSetting.mutateAsync(update);
      }
      setSubmitOk(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section
      data-testid="claude-compaction-policy-form"
      className="border border-outline-variant p-5 bg-surface-lowest/50"
    >
      <SectionHeader tone="muted">策略</SectionHeader>
      <h2 className="font-headline text-headline-sm font-bold tracking-tight uppercase text-on-surface mt-1">
        Claude 自动压缩
      </h2>
      <p className="mt-2 text-sm text-on-surface-variant max-w-prose">
        当某个 Claude 席位的上下文用量超过配置阈值时，zrig 会先发送一条准备消息，
        然后在下一个满足条件的观测点发送
        <code className="font-mono text-[12px]"> /compact</code>。压缩之后，zrig 会发送
        一条恢复提示，引导该席位读取其恢复包，随后再发一条阅读深度审计提示。
      </p>

      <form
        className="mt-4 flex flex-col gap-5"
        onSubmit={handleSubmit}
        data-testid="claude-compaction-policy-form-element"
      >
        <label className="inline-flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            data-testid="claude-compaction-enabled"
            checked={form.enabled}
            onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
          />
          <span>启用自动预压缩触发</span>
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-threshold" className="text-sm font-medium text-on-surface">
            阈值百分比
          </label>
          <input
            id="claude-compaction-threshold"
            data-testid="claude-compaction-threshold"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={form.thresholdPercent}
            onChange={(e) => setForm((s) => ({ ...s, thresholdPercent: e.target.value }))}
            className="border border-outline-variant px-2 py-1 w-32 font-mono text-sm"
            aria-describedby="claude-compaction-threshold-hint"
          />
          <span className="text-xs text-on-surface-variant">
            当上下文用量达到或超过此百分比（1–100）时开始准备。
          </span>
          {thresholdError && (
            <span className="text-xs text-error" data-testid="claude-compaction-threshold-error">
              {thresholdError}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-pre-compact-instruction" className="text-sm font-medium text-on-surface">
            预压缩准备消息
          </label>
          <textarea
            id="claude-compaction-pre-compact-instruction"
            data-testid="claude-compaction-pre-compact-instruction"
            rows={4}
            value={form.preCompactInstruction}
            onChange={(e) => setForm((s) => ({ ...s, preCompactInstruction: e.target.value }))}
            placeholder="阅读 claude-compaction-restore 技能并为压缩做准备。"
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            zrig 会用当前上下文用量、阈值以及操作者授权的用户通道包装来包裹此消息。
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-compact-instruction" className="text-sm font-medium text-on-surface">
            压缩指令
          </label>
          <textarea
            id="claude-compaction-compact-instruction"
            data-testid="claude-compaction-compact-instruction"
            rows={3}
            value={form.compactInstruction}
            onChange={(e) => setForm((s) => ({ ...s, compactInstruction: e.target.value }))}
            placeholder="可选。zrig 触发压缩时作为 /compact <指令> 发送。"
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            可选的高级覆盖。留空则依赖 Claude 原生的压缩摘要；zrig 仍会附加一条信任通道说明。
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-inline" className="text-sm font-medium text-on-surface">
            压缩后恢复指令（内联）
          </label>
          <textarea
            id="claude-compaction-inline"
            data-testid="claude-compaction-message-inline"
            rows={4}
            value={form.messageInline}
            onChange={(e) => setForm((s) => ({ ...s, messageInline: e.target.value }))}
            placeholder="可选覆盖。留空则使用下方的指令文件路径。"
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            默认会让 Claude 阅读 claude-compaction-restore 技能。zrig 会用标记、转录和当前任务的上下文来包裹此消息。
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-file" className="text-sm font-medium text-on-surface">
            压缩后恢复指令（文件路径）
          </label>
          <input
            id="claude-compaction-file"
            data-testid="claude-compaction-message-file-path"
            type="text"
            value={form.messageFilePath}
            onChange={(e) => setForm((s) => ({ ...s, messageFilePath: e.target.value }))}
            placeholder="钩子触发时读取的额外恢复指令路径。"
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            默认指向一个用户自有的占位文件。可把任务相关的阅读清单或额外恢复说明放进去，而无需改动规范技能。
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-post-restore-audit" className="text-sm font-medium text-on-surface">
            恢复后审计消息
          </label>
          <textarea
            id="claude-compaction-post-restore-audit"
            data-testid="claude-compaction-post-restore-audit-instruction"
            rows={4}
            value={form.postRestoreAuditInstruction}
            onChange={(e) => setForm((s) => ({ ...s, postRestoreAuditInstruction: e.target.value }))}
            placeholder="阅读 claude-compaction-restore 技能并审计恢复后的阅读深度。"
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            zrig 会用必需的 全部/部分/未读 表格和不保留令牌的措辞来包裹此消息。
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="claude-compaction-policy-submit"
            disabled={setSetting.isPending}
            className="border border-outline px-4 py-2 bg-inverse-surface text-background font-medium text-sm disabled:opacity-60"
          >
            {setSetting.isPending ? "保存中…" : "保存策略"}
          </button>
          {submitOk && (
            <span className="text-sm text-success" data-testid="claude-compaction-policy-saved">
              已保存。
            </span>
          )}
          {submitError && (
            <span className="text-sm text-error" data-testid="claude-compaction-policy-submit-error">
              {submitError}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
