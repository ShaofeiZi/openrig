import { Command } from "commander";

// OPR.0.5.5.19 A7 — `zrig parked [seat]`：创始人的一键诊断。诊断在读取时由后台服务
// 推导得出（活动判定 oracle × 队列的义务面），并对两个输入都返回置信度——本命令只负责
// 渲染，绝不自行计算。

interface SeatDiagnosis {
  seatNodeId: string;
  sessionName: string;
  parked: boolean | "indeterminate";
  reason: string;
  activity: { value: string; needsInput: { count: number; reason: string | null }; decidedBy: string | null; confidence: string };
  obligations: {
    scope: string;
    openCount: number;
    heldCount: number;
    unhealthyHeldCount?: number;
    complete: boolean;
    limit: number;
    items: Array<{ qitemId: string; state: string; summary?: string | null }>;
    held?: Array<{
      qitemId: string;
      state: string;
      summary?: string | null;
      healthy?: boolean;
      wake: { kind: string; ref: string; live: boolean; unconsumed?: boolean; deliveryStatus?: string | null } | null;
    }>;
  };
  confidence: { activity: string; obligations: string };
}

function verdictWord(parked: boolean | "indeterminate"): string {
  return parked === true ? "已驻留" : parked === false ? "未驻留" : "不确定";
}

function renderSeat(d: SeatDiagnosis): void {
  console.log(`${d.sessionName}：${verdictWord(d.parked)} — ${d.reason}`);
  console.log(`  活动：${d.activity.value}${d.activity.needsInput.count > 0 ? `（待输入 ×${d.activity.needsInput.count}：${d.activity.needsInput.reason}）` : ""} [判定依据 ${d.activity.decidedBy ?? "无 — 未知"}；置信度 ${d.confidence.activity}]`);
  console.log(`  义务：${d.obligations.openCount} 个未结，${d.obligations.heldCount} 个持有 [${d.obligations.scope}；${d.obligations.complete ? "已完整" : `可能在 ${d.obligations.limit} 处被截断`}]`);
  for (const item of d.obligations.items.slice(0, 10)) {
    console.log(`    - ${item.state} ${item.qitemId}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  if (d.obligations.items.length > 10) console.log(`    …另有 ${d.obligations.items.length - 10} 条`);
  for (const item of d.obligations.held ?? []) {
    const wake = item.wake;
    const wakeText = wake
      ? `${wake.kind} ${wake.ref}：${wake.unconsumed ? `已触发但未被消费${wake.deliveryStatus ? `（${wake.deliveryStatus}）` : ""}` : wake.live ? "存活" : "未存活"}`
      : "无已记录的唤醒";
    console.log(`    - 持有 ${item.qitemId}${item.summary ? ` — ${item.summary}` : ""} [${wakeText}]`);
    if (!item.healthy && !(wake?.live && !wake.unconsumed)) {
      console.log("      补救：挂载一个存活的 watchdog 标识、设置一个原子定时器，或指定一个存活的阻塞队列项；有工作区归属的延后/非紧急工作应放入其任务目标/切片。");
    }
  }
}

export function parkedCommand(): Command {
  return new Command("parked")
    .description("我们是否已驻留？推导式诊断：因欠工作而停摆的席位；HELD 仅在其记录的唤醒仍存活时才算健康")
    .argument("[seat]", "席位节点 id 或规范会话名；省略则诊断整个工作组")
    .option("--rig <rig>", "工作组范围（默认取自 OPENRIG_SESSION_NAME 中本席位所属的工作组；带 @rig 的席位参数会自动限定范围）")
    .option("--json", "以 JSON 输出完整诊断")
    .action(async (seat: string | undefined, opts: { json?: boolean; rig?: string }) => {
      const { DaemonClient } = await import("../client.js");
      const client = new DaemonClient();
      // WAVE-O B2：诊断是工作组范围的——需携带坐标。seat@rig 参数自带范围；
      // 否则依次取 --rig、再取 shell 自身的席位身份。若都无法解析，则原样透传后台服务的拒绝。
      const params = new URLSearchParams();
      if (seat) params.set("seat", seat);
      if (!seat?.includes("@")) {
        const envSession = process.env["OPENRIG_SESSION_NAME"];
        const rig = opts.rig ?? (envSession?.includes("@") ? envSession.split("@")[1] : undefined);
        if (rig) params.set("rig", rig);
      }
      const qs = params.toString();
      let data: { ok: boolean; error?: string; scope?: { rig: string; resolvedFrom: string }; seat?: SeatDiagnosis; rig?: { parked: boolean | "indeterminate"; reason: string; seats: SeatDiagnosis[]; scope?: { rig: string; resolvedFrom: string } } };
      try {
        const res = await client.get<typeof data>(`/api/activity/parked${qs ? `?${qs}` : ""}`);
        data = res.data;
      } catch (err) {
        console.error(`已拒绝：驻留诊断是实时根据 oracle 与队列推导的——需要一个可达的后台服务（${(err as Error).message}）。`);
        process.exitCode = 1;
        return;
      }
      if (!data.ok) {
        console.error(`已拒绝：${data.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(data));
        return;
      }
      if (data.seat) {
        if (data.scope) console.log(`范围：工作组 ${data.scope.rig}（来自 ${data.scope.resolvedFrom}）`);
        renderSeat(data.seat);
        return;
      }
      const rig = data.rig!;
      console.log(`工作组：${verdictWord(rig.parked)} — ${rig.reason}`);
      if (rig.scope) console.log(`范围：工作组 ${rig.scope.rig}（来自 ${rig.scope.resolvedFrom}）`);
      for (const d of rig.seats) {
        if (d.parked === false) continue; // 值得关注的是已驻留 + 不确定的格子
        renderSeat(d);
      }
    });
}
