import { DaemonClient, StartupRequestError } from "./daemon-client.js";
import { probeCrashCart, type CrashCartRenderOpts } from "./crash-cart/from-emit.js";
import { LocalReadingController, localLines, type LocalReadingState, type LocalRequest, type LocalResult } from "./local-reading.js";
import type { Action } from "./types.js";

export interface StartupSeat {
  logicalId: string; nodeId: string; runtime: string; model: string | null;
  revision: string; hasHistory: boolean; intendedAction: string; reason?: string;
  freshRequired: boolean; tokenState: string;
  freshAllowed?: boolean; prerequisite?: string; contextPending?: boolean;
  observed: { state: string; detail: string; sessionName: string };
}
interface StartupRig { rigId: string; rigName: string; seats: StartupSeat[] }
export interface StartupState {
  connection: "probing" | "up" | "down" | "unverified";
  local?: LocalReadingState;
  open: boolean; busy: boolean; page: "probe" | "down" | "unavailable" | "rigs" | "seats" | "kernel" | "confirm";
  target: string; home: string; notice: string; detail: string; expanded: boolean;
  selected: number; scroll: number; rigs: Array<{ id: string; name: string }>;
  rig?: StartupRig; probe?: CrashCartRenderOpts; freshBlocked?: string;
  prerequisites?: { codex: string; claudeCode: string };
  consent?: { rigId: string; seat: StartupSeat };
}
export interface StartupDeps {
  client: DaemonClient;
  home: string;
  probe: () => Promise<string>;
  startDaemon: () => Promise<void>;
  onChange: () => void;
  onHelp?: () => void;
  readLocal?: (request: LocalRequest) => Promise<LocalResult>;
  onNative?: (seat: StartupSeat) => Promise<void>;
  onWork: (rig?: Pick<StartupRig, "rigId" | "rigName">, seat?: StartupSeat) => void;
}

export class StartupController {
  readonly state: StartupState;
  private local?: LocalReadingController;
  private automaticEntry = true;
  /** 任何用户输入，包括帮助和控制套接字命令，拥有导航。 */
  interacted(): void { this.automaticEntry = false; }
  constructor(private readonly deps: StartupDeps) {
    this.state = { connection: "probing", open: true, busy: false, page: "probe", target: deps.client.baseUrl,
      home: deps.home, notice: "正在读取启动状态…", detail: "", expanded: false,
      selected: 0, scroll: 0, rigs: [] };
  }
  private changed() { this.deps.onChange(); }
  private async run(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.changed();
    try { await action(); }
    catch (error) {
      this.state.notice = error instanceof Error ? error.message : String(error);
      this.state.detail = this.state.notice;
      if (error instanceof StartupRequestError && (error.status === 401 || error.status === 403 || error.result.freshAllowed === false)) {
        this.state.freshBlocked = this.state.notice;
      }
    } finally { this.state.busy = false; this.changed(); }
  }
  async open() {
    this.interacted();
    this.local?.close(); this.local = undefined; this.state.local = undefined;
    this.state.open = true; this.state.consent = undefined;
    this.changed(); await this.refresh();
  }
  async refresh() {
    await this.run(async () => {
      this.state.consent = undefined;
      this.state.connection = "probing";
      this.state.notice = "正在读取实际状态…";
      let rigs;
      try {
        // 正常入口使用所选目标的认证读取及其现有
        // 截止时间。较短的恢复探测不是读取工作的前提。
        rigs = await this.deps.client.rigsSummary();
        if (!Array.isArray(rigs) || rigs.some((r) => !r || typeof r.id !== "string" || typeof r.name !== "string")) throw new Error("后台服务未返回可用的工作组列表。");
      } catch (error) {
        const probe = await probeCrashCart(this.deps.probe);
        const readError = error instanceof Error ? error.message : String(error);
        this.state.probe = probe;
        this.state.detail = [readError, probe.unavailable ?? JSON.stringify(probe.daemonEvidence ?? {})].join("\n");
        if (probe.daemonState === "down" && !probe.unavailable) {
          this.state.connection = "down";
          this.state.page = "down";
          this.state.notice = probe.crashCart?.mode === "first-run" ? "欢迎。此实例尚无已保存的工作组。" : "后台服务已停止。已保存的工作组仍然可用。";
        } else {
          this.state.connection = "unverified";
          this.state.page = "unavailable";
          this.state.notice = readError;
        }
        return;
      }
      this.state.probe = undefined;
      this.state.detail = "";
      this.state.connection = "up";
      this.state.rigs = rigs.sort((a, b) => Number(b.name === "kernel") - Number(a.name === "kernel") || a.name.localeCompare(b.name));
      if (this.state.rig && this.state.rigs.some((r) => r.id === this.state.rig!.rigId)) await this.readRig(this.state.rig.rigId);
      else { this.state.page = "rigs"; this.state.selected = 0; }
      this.state.notice = "后台服务已连接。选择要恢复的内容。";
      // 服务的折叠仅在非空工作组的节点全部
      // 观察为运行中时运行。缺失、已停止、降级和未验证不是证明。
      const running = rigs.find(r => r.lifecycleState === "running");
      if (this.automaticEntry && this.state.open && running) {
        this.automaticEntry = false;
        this.state.open = false;
        this.deps.onWork();
      }
    });
  }
  private async readRig(id: string) {
    const rig = await this.deps.client.startupRequest<StartupRig>(`/${encodeURIComponent(id)}`);
    if (!Array.isArray(rig.seats) || rig.seats.some((s) => typeof s.logicalId !== "string" || typeof s.revision !== "string" || !s.observed)) throw new Error("此后台服务的席位启动选择不可用。");
    rig.seats.sort((a, b) => Number(b.logicalId === "operator.agent") - Number(a.logicalId === "operator.agent") || a.logicalId.localeCompare(b.logicalId));
    this.state.rig = rig;
    this.state.page = "seats";
    this.state.selected = Math.min(this.state.selected, Math.max(0, rig.seats.length - 1));
    this.state.consent = undefined;
    this.state.freshBlocked = undefined;
  }
  async key(key: string) {
    this.interacted();
    const s = this.state;
    // 读取导航独立于序列化效果/探测通道。
    if (key === "?") { this.deps.onHelp?.(); return; }
    if (key === "w") {
      s.consent = undefined; s.open = false; this.local?.close(); s.local = undefined;
      this.deps.onWork(s.rig); this.changed(); return;
    }
    if (s.local && this.local) {
      if (!await this.local.key(key)) { s.local = undefined; this.local = undefined; }
      this.changed(); return;
    }
    if ((key === "L" || key === "l" && s.page !== "kernel")) {
      this.local = new LocalReadingController(this.deps.readLocal ?? (async () => ({ error: "本地读取器在此启动器中不可用" })), () => this.changed());
      s.local = this.local.state; s.consent = undefined;
      if (s.page === "confirm") s.page = "seats";
      await this.local.load(); return;
    }
    if (key === "escape" && (s.busy || !["confirm", "seats", "kernel"].includes(s.page))) {
      s.consent = undefined; s.open = false; this.deps.onWork(); this.changed(); return;
    }
    if (s.busy) return;
    if (key === "d") { s.expanded = !s.expanded; this.changed(); return; }
    if (key === "r") { await this.refresh(); return; }
    if (key === "escape") {
      s.consent = undefined; s.scroll = 0;
      if (s.page === "confirm") { s.page = "seats"; s.notice = "已拒绝全新启动。未启动新会话。"; }
      else if (["seats", "kernel"].includes(s.page)) { s.page = "rigs"; s.rig = undefined; s.selected = 0; }
      this.changed(); return;
    }
    const count = s.page === "rigs" ? s.rigs.length : s.rig?.seats.length ?? 0;
    if (s.expanded && (key === "up" || key === "down")) {
      s.scroll = Math.max(0, s.scroll + (key === "down" ? 1 : -1)); this.changed(); return;
    }
    if (key === "up" || key === "down" || key.startsWith("select:")) {
      const index = key.startsWith("select:") ? Number(key.slice(7)) : s.selected + (key === "down" ? 1 : -1);
      s.selected = Math.max(0, Math.min(count - 1, index)); s.expanded = false; s.freshBlocked = undefined;
      this.changed(); return;
    }
    if (s.page === "down" && ["s", "enter"].includes(key)) {
      let confirmed = false;
      await this.run(async () => { s.notice = "仅启动此后台服务…接下来将选择席位。"; this.changed(); await this.deps.startDaemon(); confirmed = true; });
      const failure = s.notice;
      await this.refresh();
      if (!confirmed) { s.notice = failure; s.detail = failure; this.changed(); }
      return;
    }
    if (s.page === "rigs" && key === "k" && !s.rigs.some((r) => r.name === "kernel")) {
      await this.run(async () => { s.prerequisites = await this.deps.client.startupRequest("/prerequisites"); s.page = "kernel"; }); return;
    }
    if (s.page === "kernel" && ["c", "l"].includes(key)) {
      await this.run(async () => {
        const runtime = key === "c" ? "codex" : "claude-code";
        s.notice = "正在准备内核拓扑…不启动任何席位。"; this.changed();
        const result = await this.deps.client.startupRequest<{ rigId: string }>("/kernel", { runtime });
        s.selected = 0; await this.readRig(result.rigId);
        s.notice = "内核已准备。推荐操作员席位；选择要启动的席位。";
      }); return;
    }
    if (s.page === "rigs" && key === "enter" && s.rigs[s.selected]) {
      await this.run(async () => { const id = s.rigs[s.selected]!.id; s.selected = 0; await this.readRig(id); s.notice = "仅启动所选席位。其他席位保留其历史。"; }); return;
    }
    const seat = s.rig?.seats[s.selected];
    if (s.page === "seats" && key === "t" && s.rig?.seats.some((seat) => seat.observed.state === "transport_unavailable")) {
      await this.run(async () => {
        s.notice = "仅启动终端服务…"; this.changed();
        await this.deps.client.startupRequest("/terminal", {});
        await this.readRig(s.rig!.rigId);
        s.notice = "终端服务可用。谨慎选择席位和会话。";
      }); return;
    }
    if (s.page === "seats" && seat && key === "o" && ["running", "attention_required"].includes(seat.observed.state)) {
      await this.run(async () => {
        if (!this.deps.onNative) throw new Error("此 TUI 启动器中不可用原生终端访问。");
        await this.deps.onNative(seat);
        await this.readRig(s.rig!.rigId);
        s.notice = "已从现有原生终端返回。继续前检查其状态。";
      }); return;
    }
    if (s.page === "seats" && seat && key === "c" && seat.contextPending) {
      await this.launch(s.rig!.rigId, seat, "continue"); return;
    }
    if (s.page === "seats" && seat && key === "f" && seat.hasHistory && seat.freshAllowed !== false && !s.freshBlocked) {
      s.consent = { rigId: s.rig!.rigId, seat: { ...seat } }; s.page = "confirm";
      this.changed(); return;
    }
    if (s.page === "confirm" && key === "y" && s.consent) {
      const consent = s.consent; s.consent = undefined; s.page = "seats";
      await this.launch(consent.rigId, consent.seat, "fresh"); return;
    }
    if (s.page === "seats" && seat && key === "enter") {
      if (["running", "attention_required"].includes(seat.observed.state)) { s.open = false; this.deps.onWork(s.rig, seat); this.changed(); return; }
      await this.launch(s.rig!.rigId, seat, seat.hasHistory ? "resume" : "start");
    }
  }
  private async launch(rigId: string, seat: StartupSeat, action: string) {
    await this.run(async () => {
      this.state.notice = `${action === "resume" ? "正在恢复" : "正在启动"} ${seat.logicalId}…`;
      this.changed();
      try {
        const result = await this.deps.client.startupRequest<{ message?: string; status?: string; code?: string }>(
          `/${encodeURIComponent(rigId)}/${encodeURIComponent(seat.logicalId)}`, { action, revision: seat.revision });
        this.state.notice = action === "fresh" ? "已用配置上下文启动新会话。先前历史已保留。" : result.message ?? result.status ?? result.code ?? "启动完成；检查观察状态。";
      } catch (error) {
        // 每次失败/丢失响应后读取效果。绝不自动重放 POST。
        await this.readRig(rigId).catch(() => {});
        throw error;
      }
      const notice = this.state.notice;
      await this.readRig(rigId);
      this.state.selected = Math.max(0, this.state.rig!.seats.findIndex((s) => s.nodeId === seat.nodeId));
      const observed = this.state.rig!.seats[this.state.selected]?.observed;
      this.state.notice = observed && observed.state !== "running" ? observed.detail : notice;
    });
  }
}

export function startupLines(s: StartupState): Array<{ text: string; action?: Action }> {
  const button = (text: string, key: string) => ({ text, action: { type: "startup" as const, key } });
  const lines: Array<{ text: string; action?: Action }> = [
    { text: "zrig · 启动并返回" }, { text: `后台服务：${s.target}` }, { text: "" }, { text: s.notice }, { text: "" },
  ];
  lines.push(button("?  帮助", "?"), button("w  跳过启动 · 普通视图", "w"));
  lines.push(button("L  本地读取 · 规格和意图", "L"));
  if (s.page === "down" || s.page === "unavailable") lines.push({ text: "在终端中：zrig doctor · zrig doctor --help" });
  if (s.local) return localLines(s.local);
  if (s.busy) return [...lines, { text: "正在工作…重复输入不会启动另一个操作。" }, { text: "Esc 返回/跳过 · q 退出；已接受的操作继续。" }];
  if (s.page === "down") lines.push(button("回车 / s  启动后台服务；接下来选择席位", "s"));
  if (s.page === "rigs") {
    s.rigs.forEach((r, i) => lines.push(button(`${i === s.selected ? "▶" : " "} ${r.name}${r.name === "kernel" ? " · 推荐优先" : ""}`, `select:${i}`)));
    if (!s.rigs.some((r) => r.name === "kernel")) lines.push(button("k  设置内核（推荐操作员）", "k"));
    if (s.rigs.length) lines.push(button("回车  在所选工作组中选择席位", "enter"));
  }
  if (s.page === "kernel") {
    lines.push({ text: "选择此新内核的运行时。不会更改模型或凭证。" });
    lines.push(button(`c  Codex · ${s.prerequisites?.codex ?? "不可用"}`, "c"), button(`l  Claude Code · ${s.prerequisites?.claudeCode ?? "不可用"}`, "l"));
    lines.push({ text: "不可用表示安装/认证需要在设置前修复。" });
  }
  if (s.page === "seats" && s.rig) {
    lines.push({ text: `${s.rig.rigName} · 选择一个席位；未选席位保持不变` });
    s.rig.seats.forEach((seat, i) => lines.push(button(`${i === s.selected ? "▶" : " "} ${seat.logicalId} · ${seat.observed.state} · ${seat.hasHistory ? seat.intendedAction : "新席位"}`, `select:${i}`)));
    if (s.rig.seats.some((seat) => seat.observed.state === "transport_unavailable")) lines.push(button("t  启动终端服务（不启动席位）；然后检查恢复选择", "t"));
    const seat = s.rig.seats[s.selected];
    if (seat) {
      lines.push({ text: "" }, { text: `${seat.logicalId} · ${seat.runtime} · 模型 ${seat.model ?? "配置默认"}` },
        { text: seat.prerequisite ?? (seat.observed.state === "running" && seat.contextPending
          ? "此新会话正在等待其配置的上下文。按 c 完成该投递。"
          : ["running", "attention_required", "unverified"].includes(seat.observed.state) ? seat.observed.detail : seat.reason ?? seat.observed.detail) },
        button(seat.observed.state === "running" ? "回车  打开实时工作" : seat.observed.state === "attention_required" ? "回车  检查此现有运行时" : `回车  ${seat.hasHistory ? "恢复先前会话" : "启动此新席位"}`, "enter"));
      if (["running", "attention_required"].includes(seat.observed.state)) lines.push(button("o  在此打开原生终端 · 分离以返回（默认 Ctrl-b, d）", "o"));
      if (seat.contextPending) lines.push(button("c  在解决原生前提后完成配置上下文", "c"));
      if (seat.hasHistory && seat.freshAllowed !== false && !s.freshBlocked) lines.push(button("f  考虑全新会话…", "f"));
    }
  }
  if (s.page === "confirm" && s.consent) {
    lines.push({ text: `为 ${s.consent.seat.logicalId} 启动新会话？` },
      { text: "它不会包含旧会话。旧历史已保留；配置上下文和持久职责将重新初始化。" },
      { text: "此决定仅适用于此席位和刚检查的状态。" },
      button("y  确认此全新启动", "y"), button("Esc  拒绝；保持停止", "escape"));
  }
  lines.push(button("r  刷新实际状态", "r"), button("d  诊断详情", "d"), button("Esc  返回/拒绝", "escape"), { text: "↑↓ 选择 · q 退出 · S 从普通工作打开启动" });
  if (s.expanded) lines.push({ text: "" }, { text: `实例：${s.home}` }, { text: s.detail || JSON.stringify(s.rig?.seats[s.selected] ?? s.probe ?? {}) });
  return lines;
}
