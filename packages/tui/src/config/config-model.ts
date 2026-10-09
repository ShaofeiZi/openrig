import { fieldLine, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { FleetSnapshot, ViewState } from "../types.js";
import { padEndW, clipW, strWidth } from "../text-width.js";

export interface ConfigEntry {
  key: string;
  group: "general" | "slack" | "people" | "hosts" | "health";
  value: string | number | boolean | null;
  defaultValue: string | number | boolean | null;
  defaultKnown?: boolean;
  subject?: string;
  source: string;
  visibility: "shown" | "withheld" | "unavailable";
  reason: string | null;
  scope: string;
  application: string;
}
export interface ConfigRead {
  observedAt: string; home: string | null; readOnly: boolean;
  sources: Array<{ id: string; state: string; path: string | null; detail: string }>;
  entries: ConfigEntry[]; exclusions: string[];
}
export const CONFIG_CATEGORIES = [
  { id: "instance", label: "实例与工作" },
  { id: "context", label: "上下文与技能" },
  { id: "display", label: "显示与终端" },
  { id: "waiting", label: "工作流与等待" },
  { id: "recovery", label: "恢复与快照" },
  { id: "activity", label: "活动与保留" },
  { id: "agents", label: "智能体与运行时" },
  { id: "slack", label: "Slack 与人员" },
  { id: "all", label: "全部设置 / 搜索" },
  { id: "sources", label: "来源与覆盖" },
] as const;
export function configCategory(entry: ConfigEntry): string {
  if (entry.group === "slack" || entry.group === "people") return "slack";
  if (entry.group === "hosts") return "instance";
  if (entry.group === "health") return "context";
  const key = entry.key;
  if (/^(daemon|host|db|workspace|files|progress)\./.test(key)) return "instance";
  if (/^(topology|context|skills|onboarding|health)\./.test(key)) return "context";
  if (/^(ui|terminal)\./.test(key)) return "display";
  if (/^(workflow|queue|policies\.idle_gate_qitem)\./.test(key)) return "waiting";
  if (/^(recovery|snapshots|policies\.claude_compaction)\./.test(key)) return "recovery";
  if (/^(transcripts|feed|retention)\./.test(key)) return "activity";
  if (/^(agents|runtime)\./.test(key)) return "agents";
  return "all"; // 未来注册表添加保持可发现，无需清单分叉。
}
const LABELS: Record<string, string> = {
  "host.name": "实例名称", "host.selected": "所选主机",
  "workspace.root": "工作区", "workspace.slices_root": "任务目标文件夹",
  "workspace.projects_root": "项目文件夹", "workspace.specs_root": "规格文件夹",
  "workspace.steering_path": "指导文件", "workspace.catalog_path": "工作区目录",
  "workspace.operator_seat_name": "操作员席位", "db.path": "数据库",
  "topology.root": "拓扑根", "context.root": "上下文根", "skills.root": "技能根",
  "ui.timezone": "时区", "workflow.exception_routing": "异常路由",
  "queue.wake_retry_interval_seconds": "重试间隔", "queue.wake_retry_cap": "重试上限",
  "queue.wake_unconfirmed_window_minutes": "未确认窗口", "queue.wake_swap_grace_seconds": "交换后宽限",
  "queue.pickup_stall_threshold_minutes": "停滞阈值", "queue.stuck_sweep_interval_seconds": "卡住清扫节奏",
  "queue.stuck_sweep_unclaimed_age_minutes": "未认领时长", "policies.idle_gate_qitem.auto_register": "自动注册",
  "snapshots.periodic.enabled": "定期快照", "snapshots.periodic.interval_seconds": "快照间隔",
  "snapshots.periodic.retention_keep": "保留快照数", "ui.terminal.max_live_terminals": "遗留 Web 终端上限",
  "retention.usage_samples_days": "使用样本保留",
  "transcripts.poll_interval_seconds": "转录刷新", "transcripts.lines": "转录行数",
  "ui.preview.refresh_interval_seconds": "预览刷新", "ui.preview.max_pins": "预览固定数",
  "ui.preview.default_lines": "预览行数", "context.system_world": "系统世界",
  "onboarding.default_pack.enabled": "默认入门包",
  "health.context_pressure.warning_percent": "上下文警告阈值",
  "health.context_pressure.critical_percent": "上下文严重阈值",
  "recovery.auto_drive_provider_prompts": "驱动提供商提示",
  "recovery.provider_auth_env_allowlist": "认证环境变量名",
  "policies.claude_compaction.enabled": "Claude 压缩",
  "policies.claude_compaction.threshold_percent": "压缩阈值",
  "policies.claude_compaction.pre_compact_instruction": "压缩前指令",
  "policies.claude_compaction.compact_instruction": "压缩指令",
  "policies.claude_compaction.message_inline": "恢复指令",
  "policies.claude_compaction.message_file_path": "恢复指令文件",
  "policies.claude_compaction.post_restore_audit_instruction": "恢复审计指令",
  "policies.idle_gate_qitem.scan_interval_seconds": "空闲门扫描间隔",
  "policies.idle_gate_qitem.active_wake_interval_seconds": "活动唤醒间隔",
  "policies.idle_gate_qitem.opt_in_sessions": "选择加入会话",
  "slack.credentialFile": "凭证文件引用", "slack.botToken": "机器人凭证",
  "slack.appToken": "Socket Mode 凭证", "slack.requiredScopes": "所需工作范围",
  "slack.minimumLevelThatPosts": "最低发帖级别", "slack.minimumLevelThatInterrupts": "最低打断级别",
  "feed.subscriptions.action_required": "需操作馈送", "feed.subscriptions.approvals": "审批馈送",
  "feed.subscriptions.shipped": "已发布馈送", "feed.subscriptions.progress": "进度馈送", "feed.subscriptions.audit_log": "审计馈送",
};
function words(value: string): string {
  const s = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function configLabel(entry: ConfigEntry): string {
  if (entry.subject) return entry.subject + " · " + words(entry.key.split(".").slice(2).join(".").replace(/^bindings\.[^.]+\./, "绑定 "));
  return LABELS[entry.key] ?? words(entry.key.replace(/^(?:slack|health\.policy)\./, ""));
}
export function configEntries(read: ConfigRead | null, category: string, query = ""): ConfigEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (read?.entries ?? []).filter((e) => (category === "all" || configCategory(e) === category)
    && words.every((word) => (configLabel(e) + " " + e.key).toLocaleLowerCase().includes(word)));
}
export function configValue(entry: ConfigEntry, defaultValue = false): string {
  if (defaultValue && entry.defaultKnown === false) return "未报告";
  if (entry.visibility === "unavailable" && !defaultValue) return "不可用";
  if (entry.visibility === "withheld") return "内容已隐藏";
  const v = defaultValue ? entry.defaultValue : entry.value;
  if (entry.key === "slack.outboundDestinations" && v === "") return "所有已注册人员";
  if (typeof v === "boolean" && /(?:credentialFile|credentialReference|bearer_env|bearer_file)$/.test(entry.key)) return v ? "存在" : "缺失";
  if (v === null || v === "") return "未设置";
  if (typeof v === "boolean") return v ? "开" : "关";
  if (typeof v === "number") {
    if (entry.key.endsWith("_seconds") || entry.key.endsWith("Seconds")) return v >= 60 && v % 60 === 0 ? v / 60 + " 分钟" : v + " 秒";
    if (entry.key.endsWith("_minutes")) return v + " 分钟";
    if (entry.key.endsWith("_days")) return v + " 天";
    if (entry.key.endsWith("_percent")) return v + "%";
  }
  return String(v);
}
export function configListLines(entries: ConfigEntry[], width: number, selectedKey?: string): ContentLine[] {
  const room = Math.max(20, width);
  const labelWidth = Math.max(8, Math.floor(room * .5) - 2);
  const valueWidth = Math.max(5, room - labelWidth - 16);
  return entries.map((e) => {
    const segs: NonNullable<ContentLine["segs"]> = [
      { text: (e.key === selectedKey ? "> " : "  ") + padEndW(clipW(configLabel(e), labelWidth), labelWidth) + " ", token: "bright" },
      { text: padEndW(clipW(configValue(e), valueWidth), valueWidth), token: e.visibility === "shown" ? "accentBright" : "dim", bold: true },
      { text: " " + clipW(e.source, 11), token: "dim" },
    ];
    return { text: segs.map(s => s.text).join(""), segs };
  });
}
export function configDetailLines(read: ConfigRead | null, key: string, width: number): ContentLine[] {
  const e = read?.entries.find((entry) => entry.key === key);
  if (!e) return wrapDetailLines([{ text: "刷新后设置不可用。返回列表。" }], width);
  const source = read?.sources.find((s) => s.id === e.group);
  const lines: ContentLine[] = [sectionRule(configLabel(e), width),
    fieldLine({ label: "键", value: e.key }), fieldLine({ label: "工作范围", value: e.scope }),
    fieldLine({ label: "值", value: configValue(e) }), fieldLine({ label: "默认", value: configValue(e, true) }),
    fieldLine({ label: "来源", value: e.source + (source ? " · " + source.state : "") }),
    fieldLine({ label: "覆盖", value: e.source === "env" ? "环境覆盖（高于文件和默认）"
      : e.source === "file" ? "文件设置（高于默认）" : e.source === "default" ? "默认；无覆盖报告"
      : "此来源未报告" }),
    fieldLine({ label: "应用", value: e.application })];
  if (e.reason) lines.push(fieldLine({ label: "可见性", value: e.reason }));
  if (source) lines.push(fieldLine({ label: "来源路径", value: source.path ?? "已隐藏 / 不可用" }),
    { text: source.detail });
  if (e.key === "retention.usage_samples_days" || e.key === "ui.terminal.max_live_terminals") {
    lines.push({ text: "后台服务读取支持；此键在当前 CLI 设置器注册表中缺失。" });
  }
  return wrapDetailLines(lines, width);
}
export function configSourceLines(read: ConfigRead | null, width: number): ContentLine[] {
  if (!read) return wrapDetailLines([{ text: "配置不可用。刷新或检查显示的后台服务。" }], width);
  return wrapDetailLines([
    { text: "来源与覆盖" },
    ...read.sources.flatMap((s) => [fieldLine({ label: s.id, value: s.state }), { text: s.detail }]),
    { text: "" }, ...read.exclusions.map((text) => ({ text })),
    { text: "已解析设置描述后台服务实例。客户端显示和工作组声明保留其自己的工作范围。" },
  ], width);
}

/** 设置使用正常的资源管理器、内容目标、换行和历史。 */
export function configLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  return configContentLines(state, snap, width).map(line => {
    if (line.segs || line.text.startsWith("  ──")) return line;
    const field = line.text.match(/^( {2}[^:]+:\s+)(.*)$/);
    // 设置/来源说明不是运行状态。特别地，
    // "运行中应用未验证"绝不能将"运行中"绘制为健康。
    return { ...line, segs: field
      ? [{ text: field[1]!, token: "dim" as const }, { text: field[2]!, token: "bright" as const }]
      : [{ text: line.text, token: "bright" as const }] };
  });
}

function configContentLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.config ?? null;
  const category = state.configCategory;
  const back: ContentLine = { text: "‹ 返回", action: { type: "back" } };
  if (state.configKey) return [back, ...configDetailLines(read, state.configKey, width)];
  if (category === "sources") return [back, ...wrapDetailLines([
    fieldLine({ label: "目标", value: snap.daemonTarget ?? "未报告" }),
    fieldLine({ label: "后台服务", value: snap.controlPlane ? `${snap.controlPlane.semver ?? "无版本戳"} · ${snap.controlPlane.commit ?? "提交未报告"}${snap.controlPlane.dirty ? " · 脏" : ""}` : "不可用" }),
    fieldLine({ label: "启动 CLI", value: snap.launchingCli ?? "未报告（直接 TUI 启动）" }),
    fieldLine({ label: "客户端时区", value: `${state.timeZone} · 此 TUI 启动时选择；独立于后台服务设置` }),
    fieldLine({ label: "实例主目录", value: read?.home ?? "不可用" }),
    fieldLine({ label: "观察于", value: read?.observedAt ?? "不可用" }),
  ], width), ...configSourceLines(read, width)];
  const name = read?.entries.find((e) => e.key === "host.name");
  const identity = snap.controlPlane?.selfHostId ?? (name ? configValue(name) : "未报告");
  const heading: ContentLine[] = wrapDetailLines([
    sectionRule(category ? CONFIG_CATEGORIES.find((c) => c.id === category)?.label ?? "设置" : "你的实例设置", width),
    { text: `${identity} · ${snap.daemonTarget ?? "目标未报告"}` },
    { text: "只读 · 已解析值；不推断应用" },
  ], width);
  if (!read) return [...heading, ...wrapDetailLines([
    { text: "" }, { text: "配置不可用。刷新以重试此后台服务。" },
    { text: snap.configError ?? "原因未识别。兼容性未验证。" },
    { text: "可选诊断：zrig status；zrig --version；zrig daemon 日志" }, back,
  ], width)];
  if (!category) return [...heading, { text: "" }, ...[
    ["我的工作在哪里？", "workspace.root"], ["哪个上下文根？", "context.root"],
    ["哪个时区？", "ui.timezone"], ["重试间隔多长？", "queue.wake_retry_interval_seconds"],
    ["定期快照开了吗？", "snapshots.periodic.enabled"],
  ].flatMap(([label, key]) => {
    const entry = read.entries.find(e => e.key === key);
    return wrapDetailLines([{ text: `${label}  ${entry ? configValue(entry) : "不可用"}`, action: { type: "config-setting" as const, key: key! } }], width);
  }),
  { text: "" }, { text: `Slack：${snap.connections?.state ?? "不可用"}` },
  { text: "左侧类别 · / 搜索每个设置" },
  { text: "来源与覆盖包含身份和排除项", action: { type: "config-category", category: "sources" } }, back];
  const entries = configEntries(read, category, state.filter);
  const lines: ContentLine[] = [...heading];
  if (category === "slack") lines.push(...wrapDetailLines([
    { text: `Slack：${snap.connections?.state ?? "不可用"} · 外部可达性未验证` },
    { text: `来源：${read.sources.find((s) => s.id === "slack")?.state ?? "不可用"}` },
    { text: `网关：${snap.connections?.running.state ?? "未报告"}；配置 ${snap.connections?.running.applied ?? "未报告"}` },
    { text: `下一步：${snap.connections?.nextAction ?? "zrig gateway status"}` },
    { text: "仅指导；验证显式联系 Slack。" },
  ], width));
  if (category === "display") lines.push(...wrapDetailLines([{ text: `客户端时区：${state.timeZone}（TUI 启动时选择）` }], width));
  lines.push({ text: `${entries.length} 个设置${state.filter ? ` 匹配"${state.filter}"` : ""} · 回车打开完整值/来源` }, { text: "" });
  lines.push({ text: "  设置 / 值 / 来源 · 环境 > 文件 > 默认" });
  lines.push(...configListLines(entries, width).map((line, i) => ({ ...line, action: { type: "config-setting" as const, key: entries[i]!.key } })));
  if (!entries.length) lines.push({ text: "无匹配设置。Esc 清除搜索。" });
  return lines;
}
