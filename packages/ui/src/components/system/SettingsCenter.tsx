// Slice 26——设置目的地根页（路由驱动；原为 3 标签页）。
//
// 此前是一个带 3 个内联标签页（settings / log / status）的 CENTER 工作区。按 slice 26
// release-0.3.1，设置变为 4 目的地的 Explorer，与 Topology / Project / Library / For-You
// 同级：Explorer 侧边栏持有 4 个目的地（设置 / 策略 / 日志 / 状态），各自是独立路由。
// SettingsCenter 现在只渲染 /settings 索引——配置键表单（SettingsTab），包裹在共享的
// SettingsPageShell 框架里。LogPage / StatusPage / PoliciesPage 是 /settings/* 路由下的兄弟页。

import { SettingsPageShell } from "./SettingsPageShell.js";
import { SettingsTab } from "./SettingsTab.js";

export function SettingsCenter() {
  return (
    <SettingsPageShell testId="settings-center" title="设置">
      <SettingsTab />
    </SettingsPageShell>
  );
}
