import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// Slice-04 (OPR.0.5.0.4) —— `rig provider` CLI 动词面（packet 3ffa3c22 §3），语法参照
// auth.ts 的先例（conventions/cli-read-command-grammar）。后台服务支撑：读取/预检都
// 经 DaemonClient 打向后台服务的四块读模型 + 预检；switch POST 到编排路由。
// 注意：这个 CLI 接缝本身并不拼装 `rig auth`——它只调用路由；真正的预检门控切换 +
// rig-auth codex 拼装 + 持久动作记录位于后台服务路由/服务（接缝 B/C/D），
// 其中接缝 D 解析 CLI 本地的认证拼装/打包边界。每个动词对智能体都保持 --json 稳定。

export function providerCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("provider").description(
    "提供方账号、用量信号，以及可中断安全的账号切换",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // 一致的 HTTP 错误处理：打印后台服务错误负载，4xx 退出 1 / 5xx 退出 2。
  // 4xx（例如 404 未知提供方 / 400 非法目标）是错误，绝不是成功。
  function handleHttpError(res: { status: number; data: unknown }, label: string): boolean {
    if (res.status < 400) return false;
    const p = (res.data ?? {}) as { error?: unknown; errors?: unknown };
    console.error(p.errors ?? p.error ?? `${label}失败（HTTP ${res.status}）`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  function minutesAgo(asOf: string, now: string): string {
    const delta = Date.parse(now) - Date.parse(asOf);
    if (Number.isNaN(delta)) return "年龄未知";
    return `${Math.max(0, Math.round(delta / 60000))} 分钟前`;
  }

  // 锁定的 §3 人类 `provider status` 投影：账号行、一等的绑定异常标志，
  // 以及最新信号/asOf 摘要。--json 保持逐字（由 action 处理）。
  function renderStatusHuman(m: Record<string, unknown>): void {
    const accounts = (m["accounts"] as Array<Record<string, unknown>>) ?? [];
    const bindings = (m["bindings"] as Array<Record<string, unknown>>) ?? [];
    const signals = (m["signals"] as Array<Record<string, unknown>>) ?? [];
    const readAsOf = (m["asOf"] as string) ?? "";

    console.log("账号");
    for (const a of accounts) {
      const managed = a["profileRef"] ? `profile=${a["profileRef"]}` : "未纳管";
      console.log(`  ${a["label"]}（${a["provider"]}）  auth=${a["authState"]}  ${managed}`);
    }

    const seen = new Set<string>();
    const flags: string[] = [];
    for (const b of bindings) {
      for (const an of (b["anomalies"] as Array<Record<string, unknown>>) ?? []) {
        if (an["kind"] === "same_account_on_n_seats") {
          const seats = (an["seats"] as string[]) ?? [];
          const key = `sa:${seats.join(",")}`;
          if (!seen.has(key)) { seen.add(key); flags.push(`  ! 同一账号出现在 ${an["count"]} 个席位：${seats.join(", ")}`); }
        } else if (an["kind"] === "seat_with_no_account") {
          const key = `sw:${an["seat"]}`;
          if (!seen.has(key)) { seen.add(key); flags.push(`  ! 席位未绑定账号：${an["seat"]}`); }
        }
      }
    }
    if (flags.length) { console.log("异常"); for (const f of flags) console.log(f); }

    if (signals.length) {
      const freshest = signals.reduce((a, b) => ((a["asOf"] as string) >= (b["asOf"] as string) ? a : b));
      console.log(`信号（${signals.length} 条；最新 ${minutesAgo(freshest["asOf"] as string, readAsOf)}）`);
    } else {
      console.log("信号：无");
    }

    // S-C (OPR.0.5.0.4-C) —— 在既有 `provider status` 动词上做主机级用量汇总（PM：不新增动词）。
    // 各行经 /api/provider/status 逐字返回；--json 原样输出，因此这里的人类投影就是对等面。
    // 渲染时的诚实：如实呈现（explicit_unknown 读作"未知"，绝不空白/ok），保持 C3 窗口粒度，
    // 冲突异常两事实并显（绝不静默合并），呈现部署不变量来源标签，
    // 且不输出账号身份（行中本就没有——键是主机+提供方）。
    const hostUsage = (m["hostUsage"] as Array<Record<string, unknown>>) ?? [];
    if (hostUsage.length) {
      console.log("主机用量");
      for (const r of hostUsage) {
        const state = r["state"] as string;
        const label = state === "explicit_unknown" ? "未知" : state;
        const wins = ((r["windows"] as Array<Record<string, unknown>>) ?? [])
          .map((w) => `${w["window"]} ${w["usedPercent"] ?? "?"}%`).join(", ");
        let line = `  ${r["provider"]}  ${label}`;
        if (state === "limited" && r["resetsAt"]) line += `  截至 ${r["resetsAt"]}`;
        if (state === "explicit_unknown" && r["unknownReason"]) line += `（${r["unknownReason"]}）`;
        if (wins) line += `  [${wins}]`;
        console.log(line);
        for (const an of (r["anomalies"] as Array<Record<string, unknown>>) ?? []) {
          if (an["kind"] === "conflicting_seat_windows") {
            const seats = (an["seats"] as string[]) ?? [];
            console.log(`    ! 冲突（${an["window"]}）：${seats.join(" vs ")} — ${an["evidence"]}  [该主机的不变量被证伪]`);
          }
        }
      }
      const prov = hostUsage[0]?.["provenance"] as Record<string, unknown> | undefined;
      if (prov?.["note"]) console.log(`  来源：${prov["note"]}`);
    }
  }

  // 给 FILTERED 块共用的后台服务读取：--json 逐字，人类 = 美化 JSON（§3
  // 允许 filtered 块用美化 JSON；只有 `status` 走投影）。
  async function read(path: string, json: boolean | undefined, label: string): Promise<void> {
    const client = await getClient(getDeps());
    if (!client) {
      process.exitCode = 1;
      return;
    }
    const res = await client.get<Record<string, unknown>>(path);
    if (handleHttpError(res, `读取提供方 ${label} `)) return;
    console.log(json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }

  cmd
    .command("status")
    .description("完整的四块提供方读模型（账号、绑定、信号）")
    .option("--json", "输出可解析的 JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const res = await client.get<Record<string, unknown>>("/api/provider/status");
      if (handleHttpError(res, "读取提供方状态 ")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else renderStatusHuman(res.data);
    });

  for (const block of ["accounts", "bindings", "signals"] as const) {
    cmd
      .command(block)
      .description(`提供方读模型的 ${block} 块`)
      .option("--json", "输出可解析的 JSON")
      .option("--provider <p>", "按提供方过滤（codex|claude）")
      .option("--account <a>", "按账号引用过滤")
      .action(async (opts: { json?: boolean; provider?: string; account?: string }) => {
        const qs = new URLSearchParams();
        if (opts.provider) qs.set("provider", opts.provider);
        if (opts.account) qs.set("account", opts.account);
        const q = qs.toString();
        await read(`/api/provider/${block}${q ? `?${q}` : ""}`, opts.json, block);
      });
  }

  cmd
    .command("precheck")
    .description("判断把席位切到某账号是否安全（绝不提供不安全的切换）")
    .requiredOption("--seat <s>", "席位会话")
    .requiredOption("--to-account <a>", "目标账号引用")
    .option("--json", "输出可解析的 JSON")
    .action(async (opts: { seat: string; toAccount: string; json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const qs = new URLSearchParams({ seat: opts.seat, toAccount: opts.toAccount });
      const res = await client.get<{ safe: boolean; reasons?: string[] }>(`/api/provider/precheck?${qs.toString()}`);
      if (handleHttpError(res, "precheck ")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else console.log(res.data.safe ? "安全" : `不安全：${(res.data.reasons ?? []).join("；")}`);
      if (!res.data.safe) process.exitCode = 1; // 让脚本可基于不安全判定做门控
    });

  cmd
    .command("switch")
    .description("把席位切到某账号（预检门控；由后台服务编排切换）")
    .requiredOption("--seat <s>", "席位会话")
    .requiredOption("--to-account <a>", "目标账号引用")
    .option("--force-unsafe", "覆盖非搁浅类的预检失败（仍拒绝会搁浅在线对话的切换）")
    .option("--json", "输出可解析的 JSON")
    .action(async (opts: { seat: string; toAccount: string; forceUnsafe?: boolean; json?: boolean }) => {
      const client = await getClient(getDeps());
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const res = await client.post<{ outcome?: string; reasons?: string[] }>("/api/provider/switch", {
        seat: opts.seat,
        toAccount: opts.toAccount,
        forceUnsafe: opts.forceUnsafe ?? false,
      });
      if (handleHttpError(res, "switch ")) return;
      if (opts.json) console.log(JSON.stringify(res.data));
      else console.log(res.data.outcome ?? "未知");
      if (res.data.outcome === "failed_safely") process.exitCode = 1;
    });

  return cmd;
}
