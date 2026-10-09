// 51-08 A4 — `rig usage`：唯一遥测投影的 CLI 入口
// （PM 决策 4；对应后台服务的 /api/telemetry/usage/* 路由）。只摆事实：
// 每小时 token 数、窗口速率、诚实的未知项护栏——阈值与判断归消费方
// （监督检测器）。--json 原样输出路由载荷，供脚本化检测器使用。
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/** 把人类可读时长（`90m`、`1h`、`2d`、纯小时 `1.5`）解析为小时数。
 *  无法解析时返回 null——由调用方渲染提示错误。 */
export function parseWindowToHours(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "h";
  if (unit === "m") return n / 60;
  if (unit === "d") return n * 24;
  return n;
}

interface TopPayload {
  ranked: Array<{
    seatSession: string;
    tokensPerHour: number;
    tokensDelta: number;
    resets: number;
    spanHours: number;
    samples: number;
    windows: Array<{ window: string; usedPercentFirst: number | null; usedPercentLast: number | null; percentPerHour: number | null }>;
  }>;
  unknown: Array<{ seatSession: string; reason: string }>;
  totalRankedSeats: number;
  windowHours: number;
}

export function usageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("usage").description(
    "按席位展示一段时间内的 token 遥测（序列 + top-N 消耗）——供监督检测器使用的事实数据",
  );
  const getDeps = (): StatusDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  function handleHttpError(res: { status: number; data: unknown }, label: string): boolean {
    if (res.status < 400) return false;
    const p = (res.data ?? {}) as { error?: unknown };
    console.error(p.error ?? `${label} 失败（HTTP ${res.status}）`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  cmd
    .command("top")
    .description("按窗口内 token 消耗排序的 top-N 席位")
    .option("--window <duration>", "回看窗口（90m、1h、2d 或纯小时数）", "1h")
    .option("--top <n>", "排名最多取 N 个席位")
    .option("--json", "机器可读（原样路由载荷）")
    .action(async (opts: { window: string; top?: string; json?: boolean }) => {
      const hours = parseWindowToHours(opts.window);
      if (hours === null) {
        console.error(
          `--window "${opts.window}" 无效——可接受的形式：90m、1h、2d，或纯小时数如 1.5`,
        );
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams({ window_hours: String(hours) });
      if (opts.top !== undefined) params.set("top", opts.top);
      const res = await client.get<TopPayload>(`/api/telemetry/usage/top?${params.toString()}`);
      if (handleHttpError(res, "usage top")) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.ranked.length === 0 && body.unknown.length === 0) {
        console.log(`最近 ${opts.window} 没有用量采样——序列为空`);
        return;
      }
      console.log(`token 消耗排行——最近 ${opts.window}（已排名 ${body.totalRankedSeats} 个席位）`);
      for (const [i, r] of body.ranked.entries()) {
        const winPart = r.windows
          .map((w) => `${w.window}：${w.usedPercentLast ?? "?"}%${w.percentPerHour !== null ? `（${w.percentPerHour >= 0 ? "+" : ""}${w.percentPerHour.toFixed(1)}%/h）` : ""}`)
          .join("  ");
        const resetPart = r.resets > 0 ? `  重置:${r.resets}` : "";
        console.log(
          `${i + 1}. ${r.seatSession}  ${Math.round(r.tokensPerHour).toLocaleString()} token/小时（${r.spanHours.toFixed(1)} 小时内 ${r.tokensDelta.toLocaleString()} token，${r.samples} 个样本）${resetPart}${winPart ? `  ${winPart}` : ""}`,
        );
      }
      for (const u of body.unknown) {
        console.log(`?  ${u.seatSession}  未知（${u.reason}）`); // 诚实护栏——绝不渲染成 0 行
      }
    });

  cmd
    .command("series")
    .description("每个席位的原始用量采样，按时间从早到晚")
    .option("--seat <session>", "只看指定席位会话")
    .option("--lane <lane>", "context | provider_window")
    .option("--since <iso>", "captured_at 的绝对下界（含）")
    .option("--until <iso>", "captured_at 的绝对上界（不含）")
    .option("--limit <n>", "最大行数")
    .option("--json", "机器可读（原样路由载荷）")
    .action(async (opts: { seat?: string; lane?: string; since?: string; until?: string; limit?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.lane) params.set("lane", opts.lane);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      const qs = params.toString();
      const res = await client.get<{ rows: Array<Record<string, unknown>> }>(
        `/api/telemetry/usage/series${qs ? `?${qs}` : ""}`,
      );
      if (handleHttpError(res, "usage series")) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const rows = res.data.rows;
      if (rows.length === 0) {
        console.log("没有匹配的采样——当前过滤条件下序列为空");
        return;
      }
      for (const r of rows) {
        const lane = r.lane === "provider_window"
          ? `${r.window} ${r.windowUsedPercent ?? "?"}%`
          : `tokens ${(r.totalInputTokens as number | null) ?? "?"}/${(r.totalOutputTokens as number | null) ?? "?"}，已用 ${(r.usedPercentage as number | null) ?? "?"}%`;
        console.log(`${r.capturedAt}  ${r.seatSession}  [${r.lane}] ${lane}`);
      }
    });

  return cmd;
}
