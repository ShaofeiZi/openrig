// 切片 26 — 状态目标页面（路由驱动）。
//
// 将原本内联在 SettingsCenter 标签页中的 SettingsSystemStatusPanel
// 提升为独立页面，通过自身路由挂载到 /settings/status。

import { SettingsPageShell } from "./SettingsPageShell.js";
import { SettingsSystemStatusPanel } from "./SettingsSystemStatusPanel.js";

export function StatusPage() {
  return (
    <SettingsPageShell testId="settings-page-status" title="状态">
      <SettingsSystemStatusPanel />
    </SettingsPageShell>
  );
}
