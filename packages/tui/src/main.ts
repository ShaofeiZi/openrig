#!/usr/bin/env node
import { pageReadKey } from "./page-read.js";
import { completeCommand } from "./commands/completion.js";
import { resolveTimeZone } from "./time.js";
// 入口：将四个输入适配器（命令栏/键盘/鼠标/
// 控制套接字）连接到一个实例范围视图状态（PIN 1）。tmux send-keys
// 对此进程是可驱动底线，完全不需要适配器——
// 击键就是键盘适配器。
//
//   openrig-tui [--instance <id>] [--socket <path>] [--url <daemon>] [--demo]
import { createViewState, computeExplorerRows, emptySnapshot, locationKey } from "./state.js";
import { parseCommand } from "./grammar.js";
import { filterPalette, paletteExecuteLine } from "./commands/palette.js";
import { COMMAND_REGISTRY, currentCommandContext } from "./commands/registry.js";
import { createInputDecoder, resolveEscapeAction, resolveKeyAction, resolveMouseAction, MOUSE_ENABLE, MOUSE_DISABLE, ALT_SCREEN_ON, ALT_SCREEN_OFF, PASTE_ENABLE, PASTE_DISABLE } from "./input.js";
import { renderScreen } from "./render.js";
import { createStyle, detectColorMode } from "./theme.js";
import { stylizeLines } from "./stylize.js";
import { createControlSocket, defaultSocketPath } from "./socket-server.js";
import { demoSnapshot } from "./demo-data.js";
import { DaemonClient, launchNodeNotice } from "./daemon-client.js";
import { hydrateSnapshot } from "./hydrate.js";
import { createLiveRefresh } from "./live.js";
import { subscribeActivityEvents } from "./live-events.js";
import { execFile } from "node:child_process";
import { probeCrashCart, type CrashCartRenderOpts } from "./crash-cart/from-emit.js";
import { resolveCrashCartKey, type CrashCartKeyAction } from "./crash-cart/keys.js";
import { driveRestoreLifecycle, buildRestoreLifecycleVM } from "./crash-cart/restore-lifecycle.js";
import { restoreKeyAction, type RestoreInputEvent } from "./crash-cart/restore-input.js";
import { evaluateOneClickGate, restoreConfirmMessage } from "./crash-cart/one-click-gate.js";
import { daemonStartArgs } from "./crash-cart/start-daemon.js";
import { readLocal } from "./local-reading.js";
import { StartupController } from "./startup.js";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Action, FleetSnapshot, Screen } from "./types.js";
import type { SpecReviewCache } from "./hydrate.js";
import { MOTION_FRAME_MS } from "./visual-layout.js";
import { runCopySession, processCopyTerminal } from "./print-for-copy.js";

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const instanceId = argOf(args, "--instance") ?? "tui-1";
  const demo = args.includes("--demo");
  // 重用打开此 TUI 的入口/运行时，即使在冲突的 PATH 下。
  const cliEntry = process.env["OPENRIG_TUI_CLI_ENTRY"];
  const cliExecutable = cliEntry ? process.execPath : "rig";
  const cliArgs = (args: string[]): string[] => cliEntry ? [cliEntry, ...args] : args;

  // --demo 渲染带标签 fixture；否则 §4.A 读取水合
  // 快照（首次读取应答前诚实空；失败读取
  // 显示为状态行中的命名 readErrors，绝不伪造内容）。
  let snapshot: FleetSnapshot = demo ? demoSnapshot() : emptySnapshot();
  let timeReadWarning = false;
  const timeSetting = new Promise<unknown>((resolve) => {
    execFile(cliExecutable, cliArgs(["config", "get", "ui.timezone", "--json"]), { timeout: 5000, maxBuffer: 8192 }, (err, stdout, stderr) => {
      timeReadWarning = !!err || stderr.includes("ui.timezone");
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout).value); } catch { resolve(null); }
    });
  });
  const view = createViewState({ instanceId, getSnapshot: () => snapshot, timeZoneWarning: "正在读取配置时区…" });
  let startupHeaders: () => Record<string, string> = () => ({});
  if (cliEntry) {
    try {
      const cli = await import(pathToFileURL(join(dirname(cliEntry), "client.js")).href);
      startupHeaders = cli.terminalAuthHeaders;
    } catch { /* 启动读取将暴露不可用/未授权前提 */ }
  }
  const client = demo ? null : new DaemonClient({ baseUrl: argOf(args, "--url"), headers: startupHeaders });
  let startup: StartupController | null = null;
  let nativeAttached = false;
  let shuttingDown = false;

  let inputLine = "";
  let completion: ReturnType<typeof completeCommand> | null = null;
  let lastScreen: Screen | null = null;
  // 5.2 故障诊断：后台服务关闭判定（从 `rig crash-cart --json` 动词探测）。空 ⇒
  // 正常组视图；DOWN ⇒ 恢复驾驶舱；UNVERIFIED ⇒ 无法验证屏幕。
  let crashCartOpts: CrashCartRenderOpts = {};
  let startingDaemon = false;
  // H2——非零代数 ⏎ 武装确认：下一个 ⏎ 继续，Esc 取消。绝不是静默
  // 恢复→全新降级——确认命名需要决定的席位。
  let pendingRestoreConfirm = false;
  // B1 ROUND 2——操作员对活动组恢复的运行中取消请求（生命周期
  // 驱动轮询此并到达取消端点 stop-before-next-rig）。
  let restoreCancelRequested = false;
  // B1 ROUND 3 (HIGH-2)——恢复分类列表的垂直滚动偏移，因此需求多于
  // 视口的组保持键盘可走（完成视图上的 arrow/j-k）。
  let restoreScrollOffset = 0;
  const inputDecoder = createInputDecoder();
  const style = createStyle(args.includes("--no-color") ? "none" : detectColorMode());
  let appliedCopyMode = view.get().copyMode;
  const unsubscribeCopyMode = view.subscribe((state) => {
    if (state.copyMode === appliedCopyMode) return;
    appliedCopyMode = state.copyMode;
    process.stdout.write(state.copyMode ? MOUSE_DISABLE : MOUSE_ENABLE);
  });

  // S19 round-5（守卫）：刷新所有者（live.ts）承载诚实负载
  // 生命周期和每席位新窗格输出事件；renderScreen 保持
  // 纯并以时钟 + 所有者状态为输入。motionTimer 保持
  // 仅在帧报告活跃运动（旋转器或闪烁）时重绘。
  const reviewCache: SpecReviewCache = new Map();
  const selectedSliceDirectory = (): string | null => {
    const current = view.get();
    if (current.scopesSelected) return current.scopesSelected.slice;
    if (!current.executionOpen?.startsWith("slice:")) return null;
    const id = current.executionOpen.slice("slice:".length);
    const mission = snapshot.scopes?.find((item) => item.mission === current.scopesMission);
    return mission?.slices.find((slice) => slice.id === id || slice.dirName === id)?.dirName ?? null;
  };
  const selectedRigName = (): string | null =>
    view.get().drill.find((part) => part.kind === "rig")?.name ?? null;
  const live = client
    ? createLiveRefresh({ scopeKey: () => pageReadKey(view.get()), hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), reviewCache, view.get().scopesMission, selectedSliceDirectory(), selectedRigName(), view.get()), onFrame: () => draw(), now: () => Date.now() })
    : null;
  let motionTimer: NodeJS.Timeout | null = null;
  // S19 AM-R18——打开视图自更新：oracle 推送驱动刷新所有者。
  // 仅通知；刷新通过
  // 后台服务客户端重新水合同一 ps 投影（一个 oracle，带
  // 所有者的有界安静回退；HTTP 留在客户端模块中）。
  let liveEnabled = false;
  let inputRevision = 0;
  let drawnScope = pageReadKey(view.get());
  let drawnSnapshot = snapshot;
  let drawnSettled = false;
  let previousPage: { state: ReturnType<typeof view.get>; snapshot: FleetSnapshot } | undefined;
  let activityEvents: ReturnType<typeof subscribeActivityEvents> | null = null;
  function enableLive(): boolean {
    if (!live || !client || startup?.state.connection !== "up") return false;
    liveEnabled = true;
    activityEvents ??= subscribeActivityEvents({ open: () => client.openActivityEvents(), onEvent: (event) => { if (event.type.startsWith("proof.")) reviewCache.clear(); void live.invalidate(); }, onStatus: (status) => live.connectionStatus(status) });
    return true;
  }
  function commandContext() {
    return currentCommandContext(startup && startup.state.connection !== "up" ? "unverified" : crashCartOpts.daemonState ?? null);
  }

  function draw(): void {
    if (nativeAttached) return;
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 32;
    const nowMs = Date.now();
    if (live) {
      const next = live.snapshot();
      const scope = pageReadKey(view.get());
      if (next !== drawnSnapshot && live.load().settled) {
        const oldKey = scope === drawnScope && drawnSettled
          ? computeExplorerRows(view.get(), snapshot)[view.get().selection]?.key
          : locationKey(view.get());
        const rows = computeExplorerRows(view.get(), next);
        const index = oldKey ? rows.findIndex(row => row.key === oldKey) : -1;
        const selection = index >= 0 ? index : Math.min(view.get().selection, Math.max(0, rows.length - 1));
        if (selection !== view.get().selection) view.dispatch({ type: "select", index: selection, rowCount: rows.length });
      }
      drawnScope = scope; drawnSnapshot = next; drawnSettled = live.load().settled;
    }
    if (live) snapshot = { ...live.snapshot(),
      ...(!liveEnabled ? { readErrors: [`实时数据未加载 · 连接 ${startup?.state.connection ?? "探测中"} · S 启动 · L 本地读取`] } : {}),
      launchingCli: process.env["OPENRIG_TUI_CLI_IDENTITY"]?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 180) };
    const opts = { cols, rows, nowMs, completion, colorMode: style.mode, commandContext: commandContext(), ...crashCartOpts, ...(startup?.state.open && !view.get().palette ? { startup: startup.state } : {}), restoreScroll: restoreScrollOffset, ...(liveEnabled && live ? { load: live.load(), rowFlashes: live.flashes() } : {}) };
    if (liveEnabled && live?.load().settled) previousPage = { state: { ...view.get() }, snapshot };
    const pageOptions = { ...opts, ...(liveEnabled && !live?.load().settled ? { previousPage } : {}) };
    lastScreen = renderScreen(view.get(), snapshot, pageOptions, inputLine);
    if (startup?.state.local) startup.state.local.scroll = Math.min(startup.state.local.scroll, lastScreen.contentMaxOffset);
    // 启动有自己的选择/滚动；保持底层读取器书签完整。
    if (!startup?.state.open && !view.get().palette && (!liveEnabled || live?.load().settled) && (view.get().contentMaxOffset !== lastScreen.contentMaxOffset || view.get().contentTargetCount !== lastScreen.contentTargets.length)) {
      view.dispatch({ type: "layout", contentMaxOffset: lastScreen.contentMaxOffset, contentTargetCount: lastScreen.contentTargets.length });
      lastScreen = renderScreen(view.get(), snapshot, pageOptions, inputLine);
    }
    // 样式是测试过的纯文本层上的零宽后处理——
    // hitMap 坐标始终与屏幕上的内容匹配
    // 渲染器拥有换行。宽粘贴字符绝不能换行
    // 填充行并滚动整个帧；绘制后恢复正常换行。
    process.stdout.write("\x1b[?7l\x1b[H" + stylizeLines(lastScreen, style).map((l) => "\x1b[2K" + l).join("\r\n") + "\x1b[?7h");
    if (motionTimer) clearTimeout(motionTimer);
    motionTimer = lastScreen.motionActive || lastScreen.commandMotionActive ? setTimeout(draw, MOTION_FRAME_MS) : null;
  }

  // 5.2 故障诊断：通过已交付的 `rig crash-cart --json` 动词探测后台服务关闭判定（其
  // JSON 是真相，即使在提示非零退出时）。任何失败 → 正常 TUI（绝不伪造驾驶舱）。
  const runCrashCartVerb = (): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cliExecutable, cliArgs(["crash-cart", "--json"]), { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (stdout && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim() || err?.message || "crash-cart: 无输出"));
      });
    });
  if (client) startup = new StartupController({
    client, home: process.env["OPENRIG_HOME"] ?? "默认本地实例", probe: runCrashCartVerb,
    startDaemon: () => new Promise<void>((resolve, reject) => {
      execFile(cliExecutable, cliArgs(daemonStartArgs(client.baseUrl)), { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`后台服务启动未确认完成: ${stderr.trim() || stdout.trim() || error.message}`));
        else resolve();
      });
    }),
    onChange: () => {
      draw();
      // 探测期间的跳过必须保持跳过，但可以在
      // 连接稍后应答时开始读取。这绝不改变所选页面。
      if (!startup?.state.open && startup?.state.connection === "up" && !liveEnabled && enableLive()) void live?.refresh();
    },
    onHelp: () => { view.dispatch({ type: "palette-open" }); draw(); },
    readLocal: (request) => readLocal(cliEntry, request),
    onNative: async (seat) => {
      if (!cliEntry || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
        throw new Error("原生终端访问需要此 TUI 在所选后台服务的机器上。");
      }
      const { attachSharedTui } = await import(pathToFileURL(join(dirname(cliEntry), "shared-tui.js")).href);
      nativeAttached = true;
      process.stdin.pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
      try {
        const code = await attachSharedTui(seat.observed.sessionName);
        if (code !== 0) throw new Error(`原生终端附加退出 ${code}。刷新以检查现有占用者。`);
      } finally {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE);
        nativeAttached = false;
      }
    },
    onWork: async (rig, seat) => {
      const revision = inputRevision;
      crashCartOpts = {};
      view.dispatch({ type: "notice", message: startup?.state.connection === "up" ? "" : "实时数据等待已确认连接 · S 启动 · L 本地" });
      draw();
      if (!enableLive()) return;
      await live?.refresh();
      if (revision !== inputRevision) return;
      const current = live?.snapshot() ?? snapshot;
      const host = current.hosts.find((host) => host.rigs.some((entry) => entry.id === rig?.rigId));
      if (rig && host) {
        view.dispatch({ type: "drill", resource: "rig", name: rig.rigName, target: { host: host.name } });
        await live?.refresh();
      }
      if (revision !== inputRevision) return;
      if (seat && host) view.dispatch({ type: "drill", resource: "agent", name: seat.observed.sessionName, target: { host: host.name, rig: rig!.rigName } });
      draw();
    },
  });
  async function refreshCrashCart(): Promise<void> {
    crashCartOpts = await probeCrashCart(runCrashCartVerb);
    draw();
  }
  // 执行驾驶舱动作键。start-daemon/restore 执行 `rig daemon start`（⏎ 流的 `s` 步；
  // RESTORE 最终驱动的 C1 批次导体此波排除）然后重新探测；重试
  // 重新探测（UNVERIFIED）。inspect/onboarding 是此波的入口接缝。
  // ⏎ 恢复全部：启动后台服务（`s` 步），然后 TUI 拥有恢复生命周期
  // 针对它——通过后台服务客户端 kick/poll/cancel，保留尝试 id（r2：不再盲目
  // 委托给缓冲子进程）。每次轮询更新恢复渲染（进度来自汇总
  // 流）；完成时汇总 + 键盘可走分类列表渲染；'c' 运行中取消。
  // 轮询一次恢复尝试到完成/分离，每次轮询渲染一帧。被初始 ⏎
  // 恢复和从分离视图重新附加（attemptId 设置）共享。驱动内部容忍瞬时轮询
  // 错误（持续连续后分离，绝不因单次闪烁抛出），因此此 .catch
  // 仅在真实 kick/启动侧失败时触发——绝不在单次闪烁轮询上（r1 细化 2）。
  function pollRestore(daemonClient: DaemonClient, attemptId?: string): void {
    void driveRestoreLifecycle({
      client: daemonClient,
      attemptId,
      onFrame: (frame) => {
        // 从轮询流渲染进度——每次轮询的运行中帧，不仅在完成时
        crashCartOpts = { ...crashCartOpts, restore: buildRestoreLifecycleVM(frame) };
        draw();
      },
      isCancelRequested: () => restoreCancelRequested,
    }).catch((e: unknown) => {
      crashCartOpts = { ...crashCartOpts, restore: undefined };
      view.dispatch({ type: "notice", message: `组恢复失败: ${e instanceof Error ? e.message : String(e)}` });
      void refreshCrashCart();
    });
  }

  function runFleetRestore(): void {
    if (!client) {
      view.dispatch({ type: "notice", message: "演示模式: 恢复已禁用" });
      draw();
      return;
    }
    const daemonClient = client;
    restoreCancelRequested = false;
    restoreScrollOffset = 0;
    new Promise<void>((resolve, reject) =>
      execFile("rig", ["daemon", "start"], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())),
    )
      .then(() => pollRestore(daemonClient))
      .catch((e: unknown) => {
        crashCartOpts = { ...crashCartOpts, restore: undefined };
        view.dispatch({ type: "notice", message: `组恢复失败: ${e instanceof Error ? e.message : String(e)}` });
        void refreshCrashCart();
      });
  }

  // 分离视图 `r`/`c`：针对仍在运行的尝试恢复实时视图。`c` 先设置取消
  // 标志，因此恢复的驱动 POST 取消且操作员看到它生效（可观察
  // 确认，不是静默成功 POST——r1 问题 1）。重新附加绝不重置取消标志。
  function reattachRestore(attemptId: string): void {
    if (!client) return;
    pollRestore(client, attemptId);
  }

  function performCrashCart(action: CrashCartKeyAction): void {
    if (startingDaemon) return;
    if (action === "details") {
      crashCartOpts = { ...crashCartOpts, unavailableExpanded: !crashCartOpts.unavailableExpanded };
      restoreScrollOffset = 0;
      draw();
      return;
    }
    if (action === "start-daemon") {
      let startArgs: string[];
      try { startArgs = daemonStartArgs(client!.baseUrl); }
      catch (error) {
        crashCartOpts = { unavailable: error instanceof Error ? error.message : String(error) };
        draw();
        return;
      }
      startingDaemon = true;
      crashCartOpts = { ...crashCartOpts, starting: client!.baseUrl };
      draw();
      execFile(cliExecutable, cliArgs(startArgs), { timeout: 30_000 }, (error, stdout, stderr) => {
        startingDaemon = false;
        if (error) {
          crashCartOpts = { unavailable: `后台服务启动未确认完成。重试在再次尝试前读取实际状态。 ${stderr.trim() || stdout.trim() || error.message}` };
          draw();
        } else {
          void refreshCrashCart();
          void live?.refresh();
        }
      });
      return;
    }
    if (action === "restore") {
      // 零代数一键（门已清除）——直接恢复。
      runFleetRestore();
      return;
    }
    if (action === "restore-confirm") {
      // H2——某些工作组有不可恢复席位：命名增量并武装确认（下一个 ⏎
      // 继续并全新启动它们；Esc 取消）。绝不是静默恢复→全新降级。
      const gate = evaluateOneClickGate({
        foundOnHost: (crashCartOpts.crashCart?.foundOnHost ?? []).map((r) => ({
          rigName: r.name,
          seatCount: r.seatCount,
          resumableCount: r.resumableCount,
        })),
      });
      pendingRestoreConfirm = true;
      // 真实（r2 HIGH-2）：描述恢复实际产生的等待决定——绝不
      // 无参数恢复不请求的全新启动。ROUND 10：在驾驶舱中渲染它
      //（crashCartOpts.confirm）——ViewState.notice 不在后台服务关闭驾驶舱中显示，因此
      // 第一个 ⏎ 过去看似无动作。notice 作为非驾驶舱上下文的备份保留。
      const confirmMsg = restoreConfirmMessage(gate.deltas);
      crashCartOpts = { ...crashCartOpts, confirm: confirmMsg };
      view.dispatch({ type: "notice", message: confirmMsg });
      draw();
      return;
    }
    if (action === "retry") void refreshCrashCart();
    // inspect / onboarding：入口接缝（此波无驾驶舱 notice 通道）。
  }

  function refreshFromActivity(): void {
    if (enableLive()) void live?.refresh();
  }

  const socketPath = argOf(args, "--socket") ?? defaultSocketPath(instanceId);
  const socket = await createControlSocket({
    socketPath,
    view,
    onMutation: () => {
      inputRevision += 1; startup?.interacted();
      if (startup) startup.state.open = false;
      draw();
      refreshFromActivity();
    },
    currentContext: () => commandContext(),
  });

  // 动作是驱动结构后台服务写入（BR-8/BR-9）——在此针对
  // 两个现有契约执行；视图状态仅被告知结果。
  async function executeAct(action: Extract<Action, { type: "act" }>): Promise<void> {
    if (!client || startup?.state.connection !== "up") {
      view.dispatch({ type: "notice", message: "实时动作需要已确认的后台服务连接。S 打开启动；L 打开本地读取。" });
      draw();
      return;
    }
    try {
      if (action.act === "open-terminal") {
        const result = await client.openTerminal(action.view, action.expectedPlan);
        view.dispatch({
          type: "terminal-result", view: action.view,
          message: `${result.absent.length || result.degraded.length ? "部分打开" : "已打开"}: ${result.opened.length} 已打开, ${result.absent.length} 缺失, ${result.degraded.length} 降级 · ${action.view}${result.error ? ` · ${result.error}` : ""}${result.degraded.map(m => ` · ${m.seat}: ${m.reason}`).join("")}${(result.notes ?? []).map(n => ` · ${n}`).join("")}`,
        });
        if (action.expectedPlan === undefined) view.dispatch({ type: "notice", message: `${result.opened.length} 个终端已打开; ${result.absent.length} 缺失; ${result.degraded.length} 降级${(result.notes ?? []).map(n => ` · ${n}`).join("")}` });
      } else {
        const result = await client.launchNode(action.rigId, action.agent);
        view.dispatch({ type: "notice", message: launchNodeNotice(action.agent, result) });
      }
    } catch (err) {
      if (action.act === "open-terminal") view.dispatch({ type: "terminal-result", view: action.view, message: err instanceof Error ? err.message : String(err) });
      view.dispatch({ type: "notice", message: err instanceof Error ? err.message : String(err) });
    }
    draw();
    refreshFromActivity();
  }

  function perform(action: Action): void {
    if (action.type === "print-for-copy") {
      // runCopySession 永不拒绝；挂起时，handleInput 和 draw 提前返回。
      void runCopySession({
        terminal: processCopyTerminal(), label: action.label, value: action.value,
        setSuspended: (on) => { nativeAttached = on; },
        isShuttingDown: () => shuttingDown,
        notice: (message) => view.dispatch({ type: "notice", message }),
        draw,
      });
      return;
    }
    if (action.type === "act") {
      view.dispatch({ type: "notice", message: `${action.act}…` });
      void executeAct(action);
      return;
    }
    if (startup?.state.open && !["palette-open", "palette-close", "notice", "error", "time-setting"].includes(action.type)) {
      startup.state.open = false; startup.state.consent = undefined;
    }
    view.dispatch(action);
    if (!["palette-open", "palette-close", "time-setting"].includes(action.type)) refreshFromActivity();
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    process.stdout.off("resize", draw);
    if (motionTimer) clearTimeout(motionTimer);
    live?.close();
    unsubscribeCopyMode();
    process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
    await socket.close();
    activityEvents?.close();
    process.exit(0);
  }
  process.stdout.on("resize", draw);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  function handleInput(events: ReturnType<typeof inputDecoder.write>): void {
    if (nativeAttached) return;
    for (const ev of events) {
      inputRevision += 1; startup?.interacted();
      if (startup?.state.open && !view.get().palette) {
        if (ev.type === "char" && ev.ch === "q") { void shutdown(); return; }
        if (ev.type === "char") void startup.key(ev.ch);
        else if (ev.type === "key") void startup.key(ev.key);
        else if (ev.type === "mouse" && lastScreen) {
          const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
          if (hit?.action.type === "startup") void startup.key(hit.action.key);
        }
        continue;
      }
      if (!view.get().palette && ev.type === "char" && inputLine === "") {
        if (ev.ch === "?") { view.dispatch({ type: "palette-open" }); continue; }
        if (ev.ch === "S") { void startup?.open(); continue; }
        if (ev.ch === "L" && startup) { startup.state.open = true; void startup.key("L"); continue; }
      }
      if (crashCartOpts.unavailable && !crashCartOpts.restore && !view.get().palette) {
        if (ev.type === "char" && ev.ch === "q") { void shutdown(); return; }
        if (ev.type === "char") {
          const action = resolveCrashCartKey(ev.ch, crashCartOpts);
          if (action) performCrashCart(action);
        }
        if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) {
          restoreScrollOffset = Math.max(0, Math.min(lastScreen?.contentMaxOffset ?? 0,
            restoreScrollOffset + (ev.key === "down" ? 1 : -1)));
        }
        continue;
      }
      if (!(ev.type === "key" && ev.key === "tab")) completion = null;
      // REGISTRY I3——面板模式打开时捕获输入。执行与
      // 直接键入字节相等：无参数选择运行 perform(parseCommand(line))——命令栏
      // 使用的确切 BR-9 单解析器路径；有参数选择预填充栏。
      const pal = view.get().palette;
      if (pal) {
        if (ev.type === "paste") { view.dispatch({ type: "palette-query", query: pal.query + ev.text }); continue; }
        if (ev.type === "char") {
          view.dispatch({ type: "palette-query", query: pal.query + ev.ch });
          continue;
        }
        if (ev.type === "key" && ev.key === "backspace") {
          view.dispatch({ type: "palette-query", query: [...pal.query].slice(0, -1).join("") });
          continue;
        }
        if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) {
          view.dispatch({ type: "palette-move", delta: ev.key === "down" ? 1 : -1 });
          continue;
        }
        if (ev.type === "key" && ev.key === "escape") {
          view.dispatch({ type: "palette-close" });
          continue;
        }
        if (ev.type === "key" && ev.key === "enter") {
          const rows = filterPalette(pal.query, COMMAND_REGISTRY, commandContext());
          const row = rows[Math.min(pal.selection, Math.max(0, rows.length - 1))];
          view.dispatch({ type: "palette-close" });
          if (row && row.available) {
            const exec = paletteExecuteLine(row.entry);
            if (exec.mode === "execute") perform(parseCommand(exec.line, view.get().sections));
            else inputLine = exec.line;
          }
          continue;
        }
        continue;
      }
      // 活动组恢复拥有其键（优先于驾驶舱/命令栏）。键→动作
      // 决策是纯 restoreKeyAction reducer（r1：屏幕广告的每个提示必须
      // 在该状态下起作用）；main.ts 这里只是执行器。滚动在每个阶段都有效，因此
      // 溢出时页脚广告的"↑↓ 滚动"是真实的——大型组上
      // 折叠下方的生命周期动作行可达。
      if (crashCartOpts.restore) {
        const rvm = crashCartOpts.restore;
        const action = restoreKeyAction(ev as RestoreInputEvent, {
          phase: rvm.phase,
          cancelled: rvm.cancelled,
          offset: restoreScrollOffset,
          maxOffset: lastScreen?.contentMaxOffset ?? 0,
        });
        switch (action.kind) {
          case "quit":
            void shutdown();
            return;
          case "scroll":
            restoreScrollOffset = action.offset;
            draw();
            continue;
          case "cancel":
            restoreCancelRequested = true;
            view.dispatch({ type: "notice", message: "在当前工作组后取消…" });
            draw();
            continue;
          case "reattach":
            reattachRestore(rvm.attemptId);
            continue;
          case "cancel-reattach":
            restoreCancelRequested = true;
            // r1 LOW："已请求"，非"已发送"——尚未发生 POST（重新附加的驱动 POST，
            // 而在导致分离的不可达后台服务情况下它可能无法送达）。
            view.dispatch({ type: "notice", message: "已请求取消——重新附加以确认…" });
            reattachRestore(rvm.attemptId);
            continue;
          case "dismiss":
            crashCartOpts = { ...crashCartOpts, restore: undefined };
            void refreshCrashCart();
            continue;
          case "none":
            continue; // 组恢复时吞掉
        }
      }
      if (ev.type === "paste") {
        inputLine += ev.text;
        continue;
      }
      if (ev.type === "key" && ev.key === "tab") {
        if (!crashCartOpts.daemonState) {
          completion = completeCommand(inputLine, { state: view.get(), snapshot }, commandContext());
          inputLine = completion.line;
        }
        continue;
      }
      if (ev.type === "char") {
        if (ev.ch === "v" && inputLine === "") {
          perform(parseCommand("select-text", view.get().sections));
          continue;
        }
        // SCOPES 加速器：m/n 乘坐注册命令（一个路径）。
        if (inputLine === "" && view.get().section === "scopes" && view.get().scopesSelected) {
          if (ev.ch === "m") { perform(parseCommand("reqs", view.get().sections)); continue; }
          if (ev.ch === "n") { perform(parseCommand("narrative", view.get().sections)); continue; }
        }
        if (ev.ch === "?" && inputLine === "") {
          // 注册的面板触发器——通过语法，绝不偏离它。
          perform(parseCommand("?", view.get().sections));
          continue;
        }
        if (ev.ch === "q" && inputLine === "") {
          void shutdown();
          return;
        }
        if (ev.ch === "f" && inputLine === "") {
          view.dispatch({ type: "footer" });
          continue;
        }
        // 5.2 故障诊断：后台服务关闭屏幕活动时，单键是驾驶舱动作
        // （s/i/n/r），不是命令栏输入。
        if ((crashCartOpts.daemonState || crashCartOpts.unavailable) && inputLine === "") {
          const cca = resolveCrashCartKey(ev.ch, crashCartOpts);
          if (cca) {
            performCrashCart(cca);
            continue;
          }
        }
        inputLine += ev.ch;
      } else if (ev.type === "key" && ev.key === "backspace") {
        inputLine = [...inputLine].slice(0, -1).join("");
      } else if (ev.type === "key" && ev.key === "escape") {
        if (pendingRestoreConfirm) {
          // H2——取消武装的恢复确认（不发生全新启动）。清除驾驶舱横幅。
          pendingRestoreConfirm = false;
          crashCartOpts = { ...crashCartOpts, confirm: undefined };
          view.dispatch({ type: "notice", message: "已取消恢复" });
          draw();
        } else {
          const action = resolveEscapeAction(ev, view.get(), inputLine !== "");
          if (action) perform(action);
        }
        inputLine = "";
      } else if (ev.type === "key" && ev.key === "enter") {
        if (inputLine !== "") {
          perform(parseCommand(inputLine, view.get().sections));
          inputLine = "";
        } else if (pendingRestoreConfirm) {
          // H2——操作员确认非零代数恢复：继续。清除驾驶舱横幅。
          pendingRestoreConfirm = false;
          crashCartOpts = { ...crashCartOpts, confirm: undefined };
          runFleetRestore();
        } else if (crashCartOpts.daemonState) {
          // 5.2 故障诊断：⏎ 是后台服务关闭时的驾驶舱主动作（恢复全部）。
          const cca = resolveCrashCartKey("enter", crashCartOpts);
          if (cca) performCrashCart(cca);
        } else {
          if (lastScreen) {
            const action = resolveKeyAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
            if (action) perform(action);
          }
        }
      } else if (ev.type === "key" && "action" in ev) {
        if (lastScreen) {
          const action = resolveKeyAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
          if (action) perform(action);
        }
      } else if (ev.type === "mouse" && lastScreen) {
        const wheel = resolveMouseAction(ev, view.get(), lastScreen, computeExplorerRows(view.get(), snapshot).length);
        if (wheel) perform(wheel);
        else {
          const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2);
          if (hit) perform(hit.action);
        }
      }
    }
    draw();
  }

  // 裸 Esc 按键与箭头/鼠标序列的起始字节相同，因此
  // 解码器持有它。短暂安静间隙后刷新（终端约定），因此
  // 屏幕广告的 Esc（"esc 返回"、面板关闭）实际落地，而非等待
  // 下一次击键。
  let escapeFlush: NodeJS.Timeout | null = null;
  process.stdin.on("data", (bytes: Buffer) => {
    if (escapeFlush) { clearTimeout(escapeFlush); escapeFlush = null; }
    handleInput(inputDecoder.write(bytes));
    if (inputDecoder.hasPending()) {
      escapeFlush = setTimeout(() => { escapeFlush = null; handleInput(inputDecoder.flush()); }, 50);
    }
  });
  process.stdin.on("end", () => {
    handleInput(inputDecoder.flush());
  });

  process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE);
  // round-5（守卫）：第一终端帧绘制诚实在飞
  // 状态——刷新在进入备用屏幕后启动，绝不提前，
  // 因此加载可见而非在空白终端后等待
  draw();
  // 启动时探测一次后台服务关闭判定：后台服务关闭时裸 `rig` 渲染驾驶舱。
  // （`s 启动后台服务` / `r 重试` 后的键触发重新探测是后续增量。）
  if (startup) void startup.refresh();
  else if (!demo) void refreshCrashCart();
  // 仅打开的 TUI 不得施加稳态组负载。初始
  // 水合建立诚实状态；导航、命令和套接字驱动
  // 变更通过同一单飞所有者请求后续真相。
  // 可选数据和事件订阅仅在已确认实时入口时启动。
  void timeSetting.then((setting) => {
    const timezone = resolveTimeZone(setting, timeReadWarning);
    view.dispatch({ type: "time-setting", timeZone: timezone.timeZone, timeZoneWarning: timezone.warning }); draw();
  });
}

run().catch((err: unknown) => {
  process.stdout.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
