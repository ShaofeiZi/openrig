// Slice 26——策略目标页；slice 27——首个策略条目（Claude 自动压缩表单）在共享
// SettingsPageShell 中交付。

import { SettingsPageShell } from "./SettingsPageShell.js";
import { ClaudeCompactionPolicyForm } from "./ClaudeCompactionPolicyForm.js";

export function PoliciesPage() {
  return (
    <SettingsPageShell testId="settings-page-policies" title="策略">
      <p className="mb-6 text-sm text-on-surface-variant max-w-prose">
        影响智能体运行时行为的可选策略。每条策略默认关闭，可独立开启。
      </p>
      <div className="flex flex-col gap-6">
        <ClaudeCompactionPolicyForm />
      </div>
    </SettingsPageShell>
  );
}
