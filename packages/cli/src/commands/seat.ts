import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export type SeatDeps = StatusDeps;

/** 把 STDIN 全部读到 EOF 作为 UTF-8 字符串。set-resume-token 使用，使凭证
 *  绝不出现在 argv / shell 历史 / ps 中。测试可注入。 */
async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface SeatStatusResponse {
  seat_ref: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  runtime: string | null;
  current_occupant: string | null;
  typingGuard?: { desired: boolean; effective: boolean; pending: boolean; heldCount: number };
  permissions?: {
    selectionState: "explicit" | "inherit" | "unknown";
    desired: { mode: string } | null;
    lastLaunchArguments: { value: string | null; approvalPolicy?: string } | null;
    nativeEffect: "unverified";
    error?: string;
  };
  session_status: string | null;
  startup_status: string | null;
  occupant_lifecycle: string;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  restore_outcome: string;
}

interface SeatStatusError {
  ok: false;
  code: string;
  message?: string;
  error?: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
  clients?: Array<{ name: string; session: string }>;
}

interface SeatHandoverPlan {
  ok: true;
  dryRun: true;
  willMutate: false;
  seat: {
    ref: string;
    rigId: string;
    rigName: string;
    logicalId: string;
    podId: string | null;
    podNamespace: string | null;
    runtime: string | null;
  };
  source: {
    mode: "fresh" | "rebuild" | "fork" | "discovered";
    ref: string | null;
    raw: string;
    defaulted: boolean;
  };
  reason: string;
  operator: string | null;
  currentOccupant: string | null;
  currentStatus: {
    sessionStatus: string | null;
    startupStatus: string | null;
    occupantLifecycle: string;
    continuityOutcome: string | null;
    handoverResult: string | null;
    previousOccupant: string | null;
    handoverAt: string | null;
    restoreOutcome: string;
  };
  phases: Array<{
    id: "prepare" | "commit";
    title: string;
    bindingUnchangedUntilComplete: boolean;
    steps: Array<{ id: string; title: string; description: string; willMutate: false }>;
  }>;
}

interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  source: {
    mode: "fresh" | "rebuild" | "fork" | "discovered";
    ref: string | null;
    raw: string;
    defaulted: boolean;
  };
  reason: string;
  operator: string | null;
  previousOccupant: string;
  currentOccupant: string;
  previousSessionIdsSuperseded: string[];
  newSessionId: string;
  discovery: {
    id: string;
    status: "claimed";
    tmuxSession: string;
    tmuxPane: string | null;
  };
  currentStatus: SeatHandoverPlan["currentStatus"];
  handoverAt: string;
  eventSeq: number;
  /** OPR.0.5.5.5——逐来源执行记录（后台服务形状的线上镜像）。 */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string };
  sideEffects: {
    departingSessionKilled: false;
    startupContextDelivered: boolean;
    provenanceRecordWritten: false;
  };
}

interface SeatSwitchClientResponse {
  seat_ref: string;
  session: string;
  window: number;
  target: string;
  client: string;
  mutated: false;
  retargeted: true;
}

function display(value: string | null | undefined, empty = "none"): string {
  return value ?? empty;
}

function printHuman(status: SeatStatusResponse): void {
  console.log(`席位 ${status.seat_ref}`);
  console.log(`工作组：${status.rig_name}`);
  console.log(`逻辑 ID：${status.logical_id}`);
  console.log(`当前占用者：${display(status.current_occupant)}`);
  if (status.typingGuard) {
    const g = status.typingGuard;
    console.log(`输入守卫：${g.effective ? "开" : "关"}${g.pending ? `（激活中；请求 ${g.desired ? "开" : "关"}）` : ""}；保留 ${g.heldCount} 条`);
    console.log("开启期间所有自动输入暂停，包括写生命周期。关闭不会重放被保留的消息。");
  }
  console.log(`会话：${display(status.session_status, "未知")}`);
  if (status.permissions) {
    const p = status.permissions;
    console.log(`未来启动的权限模式：${p.desired?.mode ?? p.selectionState}`);
    console.log(`上次启动参数：${p.lastLaunchArguments?.value ?? "未知"}${p.lastLaunchArguments?.approvalPolicy ? `；审批=${p.lastLaunchArguments.approvalPolicy}` : ""}`);
    console.log("原生权限效果：本次状态读取未校验");
    if (p.error) console.log(`权限选择不可用：${p.error}`);
  }
  console.log(`启动：${display(status.startup_status, "未知")}`);
  console.log(`占用者生命周期：${status.occupant_lifecycle}`);
  console.log(`连续性结果：${display(status.continuity_outcome, "未知")}`);
  console.log(`交接结果：${display(status.handover_result)}`);
  console.log(`前一占用者：${display(status.previous_occupant)}`);
  console.log(`交接时间：${display(status.handover_at)}`);
}

function printHumanHandoverPlan(plan: SeatHandoverPlan): void {
  console.log(`席位交接演练：${plan.seat.ref}`);
  console.log(`工作组：${plan.seat.rigName}`);
  console.log(`逻辑 ID：${plan.seat.logicalId}`);
  console.log(`来源：${plan.source.mode}${plan.source.ref ? `:${plan.source.ref}` : ""}`);
  console.log(`原因：${plan.reason}`);
  console.log(`操作者：${display(plan.operator)}`);
  console.log(`当前占用者：${display(plan.currentOccupant)}`);
  console.log(`当前状态：session=${display(plan.currentStatus.sessionStatus, "未知")} startup=${display(plan.currentStatus.startupStatus, "未知")} lifecycle=${plan.currentStatus.occupantLifecycle}`);
  for (const phase of plan.phases) {
    console.log(phase.title);
    for (const step of phase.steps) {
      console.log(`  - ${step.title}`);
    }
  }
  console.log("未做任何改动。");
}

function printHumanHandoverResult(result: SeatHandoverMutationResult): void {
  console.log(`席位交接完成：${result.seat.ref}`);
  console.log(`工作组：${result.seat.rigName}`);
  console.log(`逻辑 ID：${result.seat.logicalId}`);
  console.log(`来源：${result.source.mode}${result.source.ref ? `:${result.source.ref}` : ""}`);
  console.log(`原因：${result.reason}`);
  console.log(`操作者：${display(result.operator)}`);
  console.log(`前一占用者：${result.previousOccupant}`);
  console.log(`当前占用者：${result.currentOccupant}`);
  console.log(`交接结果：${display(result.currentStatus.handoverResult)}`);
  console.log("席位绑定与清单出处已更新。");
  // OPR.0.5.5.5——逐来源执行记录：实际是哪个来源带过来上下文的。
  if (result.sourceOutcome?.mode === "fork") {
    console.log(`原生 fork 自 ${result.sourceOutcome.forkedFrom}：继任者从第一个字节起就承载在任会话。`);
  } else if (result.sourceOutcome?.mode === "rebuild") {
    const outcome = result.sourceOutcome;
    if (outcome.primedArtifacts.length > 0) {
      console.log(`重建自 ${outcome.primedArtifacts.length} 个持久化产物启动：`);
      for (const artifact of outcome.primedArtifacts) console.log(`  - ${artifact.address} — ${artifact.label}`);
    }
    for (const gap of outcome.gaps) console.log(`  ! 已声明但磁盘上缺失：${gap}`);
    if (outcome.emptyChainReason) {
      console.log(`重建链为空：${outcome.emptyChainReason}`);
    }
  }
  if (result.sideEffects.startupContextDelivered) {
    if (result.source.mode === "rebuild") {
      console.log("重建启动包已投递给继任者。");
    } else {
      // fresh 交接：捕获的恢复包已投递给新启动的存活继任智能体。
      console.log("捕获的启动上下文（恢复包）已投递给继任者。");
    }
    console.log("未做会话连续性、出处 markdown 或会话停止。");
  } else if (result.source.mode === "fork") {
    console.log("未投递包：fork 上下文随原生会话本身携带。");
  } else {
    // discovered 交接：操作者准备好的继任者已存活，因此不单独投递上下文。
    console.log("未做会话连续性、启动上下文投递、出处 markdown 或会话停止。");
  }
}

function printHumanSwitchClient(r: SeatSwitchClientResponse): void {
  console.log(`已把客户端 ${r.client} 的视图重定向到 ${r.target}（席位 ${r.seat_ref}）`);
  console.log("仅视图：未改动路由、队列地址、转录或席位绑定。");
}

function printSeatError(error: SeatStatusError, fallback: string): void {
  console.error(error.message ?? error.error ?? fallback);
  if (error.guidance) {
    console.error(error.guidance);
  }
  if (error.code === "seat_ambiguous" && error.matches?.length) {
    for (const match of error.matches) {
      console.error(`  ${match.logical_id}@${match.rig_name}（${display(match.current_occupant)}）`);
    }
  }
  if (error.clients?.length) {
    console.error("已连接的客户端：");
    for (const cl of error.clients) {
      console.error(`  ${cl.name}（正在查看 ${display(cl.session)}）`);
    }
  }
}

export function seatCommand(depsOverride?: SeatDeps & { readStdin?: () => Promise<string> }): Command {
  const cmd = new Command("seat")
    .description("检视 zrig 席位可观测状态");
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
  const readStdin = depsOverride?.readStdin ?? defaultReadStdin;

  const guardRequest = async (method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, json?: boolean) => {
    const deps = getDeps(); const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return;
    const client = deps.clientFactory(getDaemonUrl(daemon));
    const result = method === "GET" ? await client.get<Record<string, unknown>>(path) : await client.post<Record<string, unknown>>(path, body ?? {});
    console.log(JSON.stringify(result.data, null, json ? undefined : 2));
    if (result.status >= 400) process.exitCode = result.status >= 500 ? 2 : 1;
  };
  cmd.command("set-typing-guard").argument("<seat>").requiredOption("--enabled <boolean>", "true 暂停所有自动终端输入；false 允许新发送")
    .requiredOption("--reason <text>").option("--json").description("通过保留自动投递来保护本席位的草稿，即使在空提示处也如此")
    .addHelpText("after", `
这是一个持久的、逐席位偏好，默认关闭。开启后暂停所有自动终端输入，
即使在空提示处也如此；它不是输入检测器，也不是权限模式。消息与唤醒保留在既有发件箱中。
写生命周期操作在生效前拒绝；raw/force/仅提交选项不绕过保护。
人类直接的终端输入仍可用。其他席位保留各自设置。

当已有操作进行完时，激活可能处于 pending。读取 zrig seat status <seat>，
在依赖保护前等待 effective=true。用 zrig seat held-messages <seat>（或 --id <id>）
检视保留的内容。关闭守卫允许新发送；它从不冲刷或重试被保留的消息。
用 zrig seat retire-held-message <seat> <id> --reason <text> 退役一条已复核记录。
退役保留证据并释放配额；它不投递、也不结束工作。

活动保留默认：每席位 100 条 / 8 MiB，每条消息 1 MiB。容量满时拒绝新准入。
即使并发激活超过该上限，已提交的队列意图仍保留；请显式检视并退役它。
保护覆盖 zrig 托管的输入路径，不覆盖外部 tmux 工具或其他直接写终端的进程。
在做生命周期工作前请刻意关闭。
`)
    .action(async (seat: string, opts: { enabled: string; reason: string; json?: boolean }) => {
      if (opts.enabled !== "true" && opts.enabled !== "false") { console.error("--enabled 必须为 true 或 false"); process.exitCode = 1; return; }
      await guardRequest("POST", `/api/seat/set-typing-guard/${encodeURIComponent(seat)}`, { enabled: opts.enabled === "true", reason: opts.reason }, opts.json);
    });
  cmd.command("held-messages").argument("<seat>").option("--limit <n>", "页大小", "100").option("--offset <n>", "页偏移", "0").option("--id <id>", "按 ID 读取一条保留或已退役记录").option("--json")
    .description("在受保护终端之外读取保留的消息；读取绝不投递它们")
    .action(async (seat: string, opts: {limit: string; offset: string; id?: string; json?: boolean}) => {
      await guardRequest("GET", `/api/seat/held-messages/${encodeURIComponent(seat)}?limit=${encodeURIComponent(opts.limit)}&offset=${encodeURIComponent(opts.offset)}${opts.id ? `&id=${encodeURIComponent(opts.id)}` : ""}`, undefined, opts.json);
    });
  cmd.command("retire-held-message").argument("<seat>").argument("<id>").requiredOption("--reason <text>").option("--json")
    .description("释放一条被保留消息的活动配额并保留证据；不投递、也不结束工作")
    .action(async (seat: string, id: string, opts: {reason: string; json?: boolean}) => {
      await guardRequest("POST", `/api/seat/retire-held-message/${encodeURIComponent(seat)}/${encodeURIComponent(id)}`, { reason: opts.reason }, opts.json);
    });


  cmd
    .command("status")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("展示只读的席位交接可观测状态")
    .addHelpText("after", `
示例：
  zrig seat status spec-writer@openrig-pm
  zrig seat status spec.writer@openrig-pm --json
  zrig seat status spec.writer --json`)
    .action(async (seat: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(daemon)) return;

      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.get<SeatStatusResponse | SeatStatusError>(`/api/seat/status/${encodeURIComponent(seat)}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data as SeatStatusError;
        printSeatError(error, `席位状态失败（HTTP ${res.status}）`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      printHuman(res.data as SeatStatusResponse);
    });

  cmd
    .command("handover")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .option("--source <source>", "来源：fresh（默认；启动一个新智能体）、discovered:<id>（操作者准备好的）、fork:<id>（源会话的原生 fork）、或 rebuild（从席位持久化产物启动的新智能体）。")
    .option("--reason <reason>", "为何要交接")
    .option("--operator <address>", "发起交接的操作者")
    .option("--dry-run", "规划交接但不改变拓扑")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("规划一次安全的两阶段席位交接")
    .addHelpText("after", `
示例：
  zrig seat handover spec-writer@openrig-pm --reason context-wall --dry-run
  zrig seat handover spec-writer@openrig-pm --source rebuild --reason context-wall --dry-run --json
  zrig seat handover spec-writer@openrig-pm --source fork:0b0165d7 --reason successor-test --operator orch-lead@openrig-pm --dry-run
  zrig seat handover spec-writer@openrig-pm --source discovered:01H... --reason mvp-proof --json`)
    .action((seat: string, opts: HandoverActionOpts) => runSeatHandover(seat, opts, getDeps()));

  // OPR.0.4.3.26——席位恢复的视图重定向。把已连接的 tmux 客户端
  // 指向该席位的规范会话/窗口。仅视图：绝不改动路由/队列/转录/身份，
  // 绝不启动智能体，绝不停用会话。作为独立步骤，编排在
  // reconcile-session / handover 之后。
  cmd
    .command("switch-client")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .option("--to-window <n>", "目标窗口索引（默认 0，规范席位窗口）")
    .option("--client <id>", "指定一个已连接的 tmux 客户端（多个连接时必填）")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("把已连接 tmux 客户端的视图重定向到席位规范会话（仅视图）")
    .addHelpText("after", `
重定向客户端所看到的内容；绝不改变 zrig 路由、队列地址、转录或席位绑定。
先用 zrig reconcile-session / zrig seat handover 修复路由，再重定向视图。示例：
  zrig seat switch-client dev-impl@my-rig
  zrig seat switch-client dev-impl@my-rig --to-window 1
  zrig seat switch-client dev-impl@my-rig --client /dev/ttys003 --json`)
    .action(async (seat: string, opts: { toWindow?: string; client?: string; json?: boolean }) => {
      let toWindow: number | undefined;
      if (opts.toWindow != null) {
        const n = Number(opts.toWindow);
        if (!Number.isInteger(n) || n < 0) {
          const error: SeatStatusError = {
            ok: false,
            code: "invalid_window",
            message: `无效的 --to-window "${opts.toWindow}"：必须是非负整数。`,
          };
          if (opts.json) {
            console.log(JSON.stringify(error, null, 2));
          } else {
            printSeatError(error, "无效的 --to-window");
          }
          process.exitCode = 2;
          return;
        }
        toWindow = n;
      }

      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(daemon)) return;

      const client = deps.clientFactory(getDaemonUrl(daemon));
      const res = await client.post<SeatSwitchClientResponse | SeatStatusError>(
        `/api/seat/switch-client/${encodeURIComponent(seat)}`,
        { client: opts.client, toWindow },
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        printSeatError(res.data as SeatStatusError, `席位 switch-client 失败（HTTP ${res.status}）`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      printHumanSwitchClient(res.data as SeatSwitchClientResponse);
    });

  // OPR.0.3.4.10——清除卡住的 attention_required / failed startup_status。
  cmd
    .command("clear-attention")
    .argument("<session>", "规范会话名（例如 dev-impl@my-rig）")
    .option("--reason <text>", "操作者证明覆盖（跳过证据闸门）")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("带证据或操作者证明，清除卡住的 attention_required 启动状态")
    .addHelpText("after", `
示例：
  zrig seat clear-attention dev-impl@my-rig
  zrig seat clear-attention dev-impl@my-rig --reason "founder 重新登录，确认存活"
  zrig seat clear-attention dev-impl@my-rig --json
`)
    .action(async (session: string, opts: { reason?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(session)}/clear-attention`,
        opts.reason ? { reason: opts.reason } : {},
        { headers: terminalAuthHeaders() },
      );
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        const detail = res.data["detail"] as string | undefined;
        console.error(`${code ?? "error"}: ${detail ?? String(res.data["error"] ?? "unknown")}`);
        process.exitCode = 1;
        return;
      }
      const clearedBy = res.data["clearedBy"] as string | undefined;
      const from = res.data["from"] as string | undefined;
      console.log(`已清除 ${session}：${from} -> ready（${clearedBy}）`);
    });

  // S5（OPR.0.5.4.7）——席位生命周期动词表面：set-model / stop / clean。
  // 薄封装后台服务的 SeatLifecycleService；拒绝时按后台服务命名原样打印
  // message + guidance + 匹配列表。
  const runLifecycleVerb = async (
    path: "set-model" | "set-permissions" | "launch" | "stop" | "clean",
    seat: string,
    body: Record<string, unknown>,
    opts: { json?: boolean },
    printOk: (data: Record<string, unknown>) => void,
  ): Promise<void> => {
    const deps = getDeps();
    const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return;
    const client = deps.clientFactory(getDaemonUrl(daemon));
    const res = await client.post<Record<string, unknown>>(
      `/api/seat/${path}/${encodeURIComponent(seat)}`,
      body,
    );
    if (opts.json) {
      console.log(JSON.stringify(res.data, null, 2));
      if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }
    if (res.status >= 400) {
      printSeatError(res.data as unknown as SeatStatusError, `席位 ${path} 失败（HTTP ${res.status}）`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }
    printOk(res.data);
  };

  cmd
    .command("set-permissions")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .requiredOption("--mode <mode>", "floor、full_bypass、inherit，或绑定托管启动上下文支持的某个 Claude 模式")
    .requiredOption("--reason <text>", "这次受控未来启动选择的、可审计的理由")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("为未来托管启动选择原生权限；不重启、不改变工作姿态")
    .addHelpText("after", "\n用 inherit 清除本席位的显式选择。当前原生进程、历史、规则与 hooks 保持不变。后续生命周期动作需要自己的授权。")
    .action(async (seat: string, opts: { mode: string; reason: string; json?: boolean }) => {
      await runLifecycleVerb("set-permissions", seat, { mode: opts.mode, reason: opts.reason }, opts, data => {
        const selection = data["to"] as { mode: string } | null;
        console.log(`权限模式：${selection?.mode ?? "inherit"}${data["changed"] === false ? "（未变）" : "（已审计）"}`);
        console.log(String(data["effect"]));
      });
    });

  cmd
    .command("set-model")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .requiredOption("--model <id>", "目标模型 id（例如别名 pin 迁移到的规范 id）")
    .requiredOption("--reason <text>", "记录在 node.model_changed 事件上的审计理由")
    .option("--operator <address>", "记录在审计事件上的操作者")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("持久化席位的模型 id（已审计）；后续托管恢复使用新模型")
    .addHelpText("after", `
会话谱系不动——只改 nodes.model，每次托管恢复/继任者启动都在调用时读取它。示例：
  zrig seat set-model dev-impl@my-rig --model claude-fable-5 --reason "别名 fable -> 规范"
  zrig seat set-model dev.impl --model claude-fable-5 --reason "规范迁移" --json`)
    .action(async (seat: string, opts: { model: string; reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("set-model", seat, { model: opts.model, reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        if (data["changed"] === false) {
          console.log(`${s?.logicalId}@${s?.rigName} 的模型已是 ${String(data["to"])}——未记录变更。`);
          return;
        }
        console.log(`${s?.logicalId}@${s?.rigName} 的模型：${String(data["from"] ?? "无")} -> ${String(data["to"])}（已审计）。`);
        console.log("下一次托管恢复/继任者启动将组合新模型。");
      });
    });

  cmd
    .command("launch")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .requiredOption("--fresh", "显式创建一个空白原生占用者；不使用任何连续性来源")
    .requiredOption("--reason <text>", "记录在 seat.fresh_launched 事件上的审计理由")
    .option("--stop", "在全新启动前先停止当前存活的托管占用者")
    .option("--operator <address>", "记录在审计事件上的操作者")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("为恰好一个既有席位启动一个刻意的全新占用者")
    .addHelpText("after", `
不使用任何 resume、fork、rebuild、快照、检查点或恢复包。
存活的托管席位需要 --stop；已接管与非托管会话会被拒绝。示例：
  zrig seat launch dev-impl@my-rig --fresh --reason "刻意空白重启"
  zrig seat launch dev.impl --fresh --stop --reason "替换托管占用者" --json`)
    .action(async (seat: string, opts: { fresh: boolean; reason: string; stop?: boolean; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("launch", seat, {
        fresh: opts.fresh === true,
        reason: opts.reason,
        stop: opts.stop === true,
        operator: opts.operator,
      }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const superseded = data["supersededSessionIds"] as string[] | undefined;
        console.log(`全新占用者就绪：${s?.logicalId}@${s?.rigName}（${String(data["sessionName"])}）。`);
        console.log(`世代：${String(data["generation"])}；模型：${String(data["model"] ?? "无")}。`);
        console.log(`启动策略：${String(data["startupPolicyHash"])}；被取代的会话：${superseded?.length ?? 0}。`);
        console.log("未使用任何连续性来源；兄弟节点与持久化工作均已保留。");
      });
    });

  cmd
    .command("stop")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .requiredOption("--reason <text>", "记录在 session.stopped 事件上的审计理由")
    .option("--operator <address>", "记录在审计事件上的操作者")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("停止恰好一个存活的托管席位（只杀该席位的 tmux 会话；已审计）")
    .addHelpText("after", `
兄弟节点不受影响。已死席位会被拒绝（用 zrig seat clean）；已接管会话会被拒绝（用 zrig unclaim）。示例：
  zrig seat stop dev-impl@my-rig --reason "wave 边界退役"
  zrig seat stop dev.impl --reason "卡住的占用者" --json`)
    .action(async (seat: string, opts: { reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("stop", seat, { reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        console.log(`已停止 ${String(data["sessionName"])}（席位 ${s?.logicalId}@${s?.rigName}）。`);
        console.log("会话标记为已退出，绑定已清除；兄弟节点不受影响。经常规启动表面重新启动。");
      });
    });

  cmd
    .command("clean")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .requiredOption("--reason <text>", "记录在 session.cleaned 事件上的审计理由")
    .option("--operator <address>", "记录在审计事件上的操作者")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("把一个已死席位恢复为可启动（清除过期绑定 + 会话记录；已审计）")
    .addHelpText("after", `
存活的所有者状态保留：节点行、会话历史（含 resume token）与占用者任期台账不动。
存活席位会被拒绝（用 zrig seat stop）。示例：
  zrig seat clean dev-impl@my-rig --reason "观察到干净退出，希望重启"
  zrig seat clean dev.impl --reason "崩溃后清理" --json`)
    .action(async (seat: string, opts: { reason: string; operator?: string; json?: boolean }) => {
      await runLifecycleVerb("clean", seat, { reason: opts.reason, operator: opts.operator }, opts, (data) => {
        const s = data["seat"] as { logicalId?: string; rigName?: string } | undefined;
        const actions = data["actions"] as { sessionsExited?: string[]; bindingCleared?: boolean } | undefined;
        console.log(`已清理席位 ${s?.logicalId}@${s?.rigName}。`);
        console.log(`标记为已退出的会话：${actions?.sessionsExited?.length ? actions.sessionsExited.join(", ") : "无（已终态）"}；绑定已清除：${actions?.bindingCleared ? "是" : "否"}。`);
        console.log("所有者状态已保留（节点、会话历史、任期台账）。该席位可再次启动。");
      });
    });

  // OPR.0.4.0.22——设置托管席位的持久 resume token（已证明 + 已审计）。
  // token 只从 STDIN 读取（绝不走位置 argv——那会经 shell 历史 + argv/ps 泄露），
  // 且绝不回显。
  cmd
    .command("set-resume-token")
    .argument("<session>", "规范会话名（例如 dev-impl@my-rig）")
    .option("--token-stdin", "从 STDIN 读取 resume token（唯一支持的输入路径）")
    .requiredOption("--reason <text>", "记录在只追加审计事件中的操作者证明")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("设置托管席位的持久 resume token（token 从 stdin 读取；已证明 + 已审计）")
    .addHelpText("after", `
token 只从 STDIN 读取（绝不走参数）。示例：
  printf '%s' "$RESUME_TOKEN" | zrig seat set-resume-token dev-impl@my-rig --token-stdin --reason "founder 重新登录"
  pbpaste | zrig seat set-resume-token dev-qa@my-rig --token-stdin --reason "手动 codex 线程 id" --json
`)
    .action(async (session: string, opts: { tokenStdin?: boolean; reason: string; json?: boolean }) => {
      const deps = getDeps();
      if (!opts.tokenStdin) {
        console.error("set-resume-token 需要 --token-stdin：token 从 stdin 读取，绝不作为参数传入（那会经 shell 历史 / ps 泄露）。把它 pipe 进来，例如 printf '%s' \"$TOKEN\" | zrig seat set-resume-token <session> --token-stdin --reason \"...\"。");
        process.exitCode = 2;
        return;
      }
      const token = (await readStdin()).trim();
      if (!token) {
        console.error("stdin 上未收到 resume token。");
        process.exitCode = 2;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(session)}/resume-token`,
        { token, reason: opts.reason },
        { headers: terminalAuthHeaders() },
      );
      // 两种输出模式下都绝不回显 token（后台服务响应已脱敏）。
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        console.error(`错误：${String(res.data["message"] ?? res.data["error"] ?? "未知")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`已为 ${session} 设置 resume token：${String(res.data["resumeType"] ?? "")}（出处：operator）。token 已脱敏。`);
    });

  return cmd;
}

interface HandoverActionOpts {
  source?: string;
  reason?: string;
  operator?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** `rig seat handover` 与顶层 `rig handover` 动词共用的交接动作
 *  （OPR.0.4.3.04）。POST 到同一个后台服务路由。 */
export async function runSeatHandover(seat: string, opts: HandoverActionOpts, deps: SeatDeps): Promise<void> {
  if (!opts.reason?.trim()) {
    const error: SeatStatusError = {
      ok: false,
      code: "missing_reason",
      message: "缺少必填选项：--reason <reason>",
      guidance: "请给出明确的交接原因，例如：--reason context-wall",
    };
    if (opts.json) {
      console.log(JSON.stringify(error, null, 2));
    } else {
      printSeatError(error, "缺少必填选项：--reason <reason>");
    }
    process.exitCode = 2;
    return;
  }

  const daemon = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(daemon)) return; // B8-1b: epistemic-matched

  const client = deps.clientFactory(getDaemonUrl(daemon));
  const res = await client.post<SeatHandoverPlan | SeatHandoverMutationResult | SeatStatusError>(`/api/seat/handover/${encodeURIComponent(seat)}`, {
    source: opts.source,
    reason: opts.reason,
    operator: opts.operator,
    dryRun: opts.dryRun === true,
  });

  if (opts.json) {
    console.log(JSON.stringify(res.data, null, 2));
    if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }

  if (res.status >= 400) {
    printSeatError(res.data as SeatStatusError, `席位交接失败（HTTP ${res.status}）`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }

  const data = res.data as SeatHandoverPlan | SeatHandoverMutationResult;
  if (data.dryRun) {
    printHumanHandoverPlan(data);
  } else {
    printHumanHandoverResult(data);
  }
}

/**
 * OPR.0.4.3.04——顶层 `rig handover <seat>` 动词：面向操作者的全周期
 * 交接 composer 入口。与 `rig seat handover` 同路由、同行为；提升到顶层
 * 以便发现。
 */
export function handoverCommand(depsOverride?: SeatDeps): Command {
  const getDeps = (): SeatDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
  return new Command("handover")
    .argument("<seat>", "规范会话名或逻辑席位引用")
    .option("--source <source>", "继任者来源：fresh（默认；启动新智能体）、discovered:<id>（操作者准备好的）、fork:<id>（源会话的原生 fork）、或 rebuild（从席位持久化产物启动的新智能体）。")
    .option("--reason <reason>", "为何要交接")
    .option("--operator <address>", "发起交接的操作者")
    .option("--dry-run", "规划交接但不改变拓扑")
    .option("--json", "供智能体使用的 JSON 输出")
    .description("把席位交给继任者：创建 -> 投递上下文 -> 校验连续性 -> 重新绑定")
    .addHelpText("after", `
四种来源都会执行（OPR.0.5.5.5）：fresh 投递一个捕获的恢复包；discovered 接管
操作者准备好的存活会话；fork:<id> 启动源会话的原生 fork（继任者从第一个字节起
承载在任上下文）；rebuild 全新启动并从席位持久化产物链 prime，准确记录找到了什么。
无法继续的来源（例如 fork 无可发现的原生 id）在任何变更前诚实拒绝——
交接绝不会被悄悄完成。

示例：
  zrig handover spec-writer@openrig-pm --reason context-wall --dry-run
  zrig handover spec-writer@openrig-pm --source fresh --reason context-wall
  zrig handover spec-writer@openrig-pm --source fork:spec-writer@openrig-pm --reason context-wall
  zrig handover spec-writer@openrig-pm --source rebuild --reason degraded-incumbent
  zrig handover spec-writer@openrig-pm --source discovered:01H... --reason mvp-proof --json`)
    .action((seat: string, opts: HandoverActionOpts) => runSeatHandover(seat, opts, getDeps()));
}
