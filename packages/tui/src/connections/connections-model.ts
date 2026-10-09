import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { fieldLine, listItem, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { FleetSnapshot } from "../types.js";

/** 所选、值安全的后台服务投影；原始配置和连接器错误绝不进入 TUI。 */
export interface ConnectionsRead {
  observedAt: string; home: string | null; pid: number;
  settingsSource: string | null;
  settings: Array<{ key: string; value: string | null; source: string }>;
  configSource: { state: string; path: string | null };
  configuration: null | { enabled: boolean; channel: string | null; inboundDestination: string | null;
    outboundDestinations: Array<string | null>; postLevel: string; interruptLevel: string; botToken: string; appToken: string };
  running: { state: string; activatedAt: string | null; outboundReady: boolean | null; inboundReady: boolean | null; inboundState: string; applied: string };
  state: string; nextAction: string;
  verification: { state: string; at: string | null; actor: string | null };
  registry: { state: string; path: string | null };
  humans: Array<{ entityId: string; address: string; displayName: string | null; deliveryClass: string; availability: string; excluded: boolean | null;
    bindings: Array<{ kind: string; ref: string | null; role: string; handle: string | null }> }>;
}
/** 后台服务的只读 Slack 应用清单（GET /api/gateway/slack/manifest）。 */
export interface SlackManifestRead { yaml: string; url: string; scopes?: string[]; events?: string[] }
export const SLACK_MANIFEST_EXPAND_KEY = "slack:manifest";

/** 尚无 Slack 应用：两个令牌都无法解析。未知令牌状态不是"未配置"。 */
export function slackNotConfigured(c: ConnectionsRead): boolean {
  return !!c.configuration && c.configuration.botToken === "missing" && c.configuration.appToken === "missing";
}

/** 未配置 Slack：创建你自己的应用链接作为纯可选中文本，和一个切换
 *  原地展开清单。TUI 不打开任何内容，不接受令牌，不创建任何内容。 */
function slackSetupLines(snap: FleetSnapshot, expanded: readonly string[], width: number): ContentLine[] {
  const m = snap.slackManifest;
  const lines: ContentLine[] = [fieldLine({ label: "设置", value: "未配置 · 尚无 Slack 应用令牌" })];
  if (!m) {
    lines.push({ text: "  先创建你自己的 Slack 应用：zrig slack manifest --url（此后台服务不提供清单）。" });
    return lines;
  }
  const open = expanded.includes(SLACK_MANIFEST_EXPAND_KEY);
  lines.push({ text: "  从 zrig 的清单创建你自己的私有 Slack 应用，使用此链接：" },
    { text: "  ▸ 打印链接以复制（回车）：离开此视图并将链接显示为一行；回车返回",
      action: { type: "print-for-copy", label: "Slack 创建应用链接（来自 zrig 的清单）：", value: m.url } },
    { text: "  链接，拆成行且不添加任何内容（或运行：zrig slack manifest --url）：" },
    // 精确宽度块无缩进，使行逐字节拼回链接。
    ...Array.from({ length: Math.ceil(m.url.length / Math.max(8, width)) }, (_, i) =>
      ({ text: m.url.slice(i * Math.max(8, width), (i + 1) * Math.max(8, width)) })),
    { text: `  ${open ? "▾ 隐藏" : "▸ 显示"} 清单（回车）`, action: { type: "toggle-expand", key: SLACK_MANIFEST_EXPAND_KEY } });
  if (open) for (const line of m.yaml.trimEnd().split("\n")) lines.push({ text: `    ${line}` });
  lines.push({ text: "  然后：zrig slack setup、zrig slack verify、zrig slack enable。步骤：zrig slack manifest --help" });
  return lines;
}

export interface ControlPlaneRead {
  status?: string; semver?: string; commit?: string; dirty?: boolean; builtAt?: string;
  selfHostId?: string | null; selfHostIdSource?: string;
}
/** Slack 状态枚举 → 中文展示标签（内部枚举值保持英文）。 */
function slackStateLabel(state: string): string {
  return {
    enabled: "已启用", disabled: "已禁用", failed: "失败",
    unapplied: "未应用", unavailable: "不可用", unverified: "未验证",
    active: "活跃", stopped: "已停止", incomplete: "不完整",
    indeterminate: "不确定", matching: "匹配", changed: "已变更",
  }[state] ?? state;
}

/** 仅在展示层切换中文发行版入口；后台服务返回的兼容命令保持原样。 */
function visibleCliCommand(command: string): string {
  return command.replace(/^rig(?=\s|$)/, "zrig");
}

export function connectionsLines(snap: FleetSnapshot, width: number, timeZone = DEFAULT_TIME_ZONE, expanded: readonly string[] = []): ContentLine[] {
  const c = snap.connections;
  const h = snap.controlPlane;
  const lines: ContentLine[] = [{ text: "连接 · 此后台服务的实例" },
    ...(c ? [{ text: `  Slack：${slackStateLabel(c.state)} · 人员：${c.registry.state === "available" ? c.humans.length : "未知"} · 下一步：${visibleCliCommand(c.nextAction)}` }] : []),
    { text: "  被动视图 · 刷新不发送任何内容 · 返回回到工作" },
    sectionRule("运行中控制面", width),
    fieldLine({ label: "后台服务", value: h ? `${h.status ?? "未知"} · ${h.semver ?? "无版本戳"} · ${h.commit ?? "提交未戳"}${h.dirty === true ? " · 脏" : ""}` : "不可用 — 检查 zrig status" }),
    fieldLine({ label: "主机", value: h?.selfHostId ? `${h.selfHostId}（${h.selfHostIdSource ?? "来源未报告"}）` : "身份未报告" }),
    fieldLine({ label: "CLI 启动", value: snap.launchingCli ?? "未提供身份（直接 TUI 启动）" }),
    fieldLine({ label: "目标", value: snap.daemonTarget ?? "未报告" }),
  ];
  if (!c) return wrapDetailLines([...lines, { text: "" }, { text: "  连接不可用——后台服务无法提供此视图。" },
    { text: "  下一步：zrig status；zrig --version；zrig daemon 日志" },
    { text: "  旧后台服务可能不支持连接。不推断就绪状态。" }], width);
  lines.push(fieldLine({ label: "进程", value: `PID ${c.pid} · 主目录 ${c.home ?? "未报告"}` }),
    fieldLine({ label: "观察于", value: displayTime(c.observedAt, timeZone) }),
    sectionRule("实例设置 · 已解析值", width));
  lines.push(fieldLine({ label: "设置来源", value: c.settingsSource ?? "来源不可用" }));
  for (const s of c.settings) lines.push(fieldLine({ label: s.key === "host.name" ? "显示名称" : s.key === "workspace.root" ? "工作区" : "操作员", value: `${s.value ?? "不可用"}（${s.source}）` }));
  lines.push({ text: "  环境覆盖文件覆盖默认。这些是当前设置，非运行时采纳的证明。" },
    { text: "  在此实例上检查/更改：zrig config --with-source；zrig config set <键> <值>" },
    sectionRule("Slack · 配置和运行服务", width),
    fieldLine({ label: "投递", value: `${c.state} · 当前外部可达性未验证` }),
    fieldLine({ label: "来源", value: `${c.configSource.state} · ${c.configSource.path ?? "未报告"}` }),
    fieldLine({ label: "网关", value: `${c.running.state} · 配置 ${c.running.applied}` }));
  if (c.running.applied === "changed") lines.push({ text: "  配置自链路建立后已更改。在支持的重启前检查；不要假定已应用。" });
  if (slackNotConfigured(c)) lines.push(...slackSetupLines(snap, expanded, width));
  const cfg = c.configuration;
  if (cfg) {
    lines.push(fieldLine({ label: "已启用", value: String(cfg.enabled) }),
      fieldLine({ label: "频道", value: cfg.channel ?? "缺失" }),
      fieldLine({ label: "凭证", value: `机器人 ${cfg.botToken}；Socket Mode 应用 ${cfg.appToken}（值已隐藏）` }),
      fieldLine({ label: "出站", value: c.running.outboundReady === null ? "未报告" : `${c.running.outboundReady ? "激活时已配置" : "激活时未配置"}；发帖 >= ${cfg.postLevel}，打断 >= ${cfg.interruptLevel}（当前配置）` }),
      fieldLine({ label: "入站", value: c.running.inboundState }));
    let inboundAction: ContentLine["action"];
    for (const host of snap.hosts) for (const rig of host.rigs) for (const pod of rig.pods) {
      const a = pod.agents.find((a) => a.session === cfg.inboundDestination);
      if (a) inboundAction = { type: "drill", resource: "agent", name: a.name, target: { host: host.name, rig: rig.name, pod: pod.name } };
    }
    lines.push(fieldLine({ label: "新入站", value: cfg.inboundDestination ?? "缺失", link: inboundAction }),
      { text: "  回复跟随其现有会话；新/未映射入站使用上面配置的席位。" });
  }
  lines.push(fieldLine({ label: "上次检查", value: `${c.verification.state}${c.verification.at ? ` · ${displayTime(c.verification.at, timeZone)} · ${c.verification.actor ?? "操作者未知"}` : " · 有界审计尾中无匹配检查"}` }),
    { text: "  检查记录当时的工作范围/频道成员。它不证明投递、当前凭证或读者群。" },
    fieldLine({ label: "下一步", value: visibleCliCommand(c.nextAction) }),
    { text: "  在显示的实例上运行指导。verify 显式联系 Slack；enable/disable 保留其已审计的 CLI 行为。" },
    sectionRule("外部人员 · 实例范围注册表", width));
  if (c.registry.state !== "available") lines.push({ text: "  注册表不可用；收件人未知。下一步：zrig gateway human list --json" });
  else if (!c.humans.length) lines.push({ text: "  无已注册人员。下一步：zrig gateway human add --help" });
  const requests = [...new Map([...snap.attention, ...snap.pending, ...snap.inProgress, ...snap.blocked].map((r) => [r.qitemId, r])).values()];
  for (const human of c.humans) {
    lines.push(listItem(`${human.displayName ?? human.entityId} · ${human.address}`),
      { text: `    ${human.excluded === true ? "被出站策略排除" : human.excluded === null ? "路由资格未知" : `路由使用实例 Slack · ${slackStateLabel(c.state)}`} · 类 ${human.deliveryClass}，可用性 ${human.availability}` });
    for (const b of human.bindings) lines.push({ text: `    ${b.role}：${b.kind} ${b.ref ?? "未报告"} · 手柄 ${b.handle ?? "缺失（仅出站）"}` });
    for (const r of requests.filter((r) => r.destinationSession === human.address && ["pending", "in-progress", "blocked"].includes(r.state)).slice(0, 3)) {
      lines.push({ text: `    加载窗口中的打开请求：${r.qitemId} · 来自 ${r.sourceSession ?? "来源未报告"} · ${r.state}` },
        { text: `      检查：zrig queue show ${r.qitemId} --full` });
    }
    lines.push({ text: `    检查绑定/就绪状态（联系 Slack）：zrig gateway human show ${human.entityId} --json` });
  }
  lines.push({ text: "  主绑定是声明的默认绑定；仅注册不分配工作组也不证明可达性。" },
    sectionRule("工作和配置", width));
  for (const host of snap.hosts) for (const rig of host.rigs) {
    lines.push(listItem(`${rig.name} · 观察到 ${rig.lifecycleState ?? "未知"} · ${snap.readErrors.some((e) => e.startsWith(`nodes(${rig.name}):`)) ? "席位清单不可用" : `${rig.pods.reduce((n, p) => n + p.agents.length, 0)} 个席位`}`, { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } }));
    if (rig.authoredSpecName) lines.push(listItem(`编写规格：${rig.authoredSpecName}`, snap.specs.some((s) => s.name === rig.authoredSpecName) ? { type: "drill", resource: "spec", name: rig.authoredSpecName } : undefined));
  }
  lines.push(listItem("打开工作和工作流", { type: "jump", section: "scopes" }), listItem("人员请求和待办", { type: "jump", section: "needs" }), listItem("返回上一视图", { type: "back" }));
  return wrapDetailLines(lines, width);
}
