import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

interface RigSummaryEntry {
  id: string;
  name: string;
  archivedAt?: string | null;
  lifecycleState?: string;
}

/**
 * 把 `rig down <rig>` 句柄（名称或 id）解析为具体 id 的结果。
 * 破坏性拆除只会在 `resolved`/`passthrough` id 上运行；
 * `ambiguous`/`not_found` 在任何 `/api/down` POST 之前中止。
 */
type HandleResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; name: string; ids: string[] }
  | { kind: "not_found"; handle: string }
  // 摘要不可用（非 200 / 抓取错误）：回退到今天的仅 id 行为——
  // 把原始句柄作为 id POST，让后台服务按精确 id 解析（缺失则 404）。
  // 安全：后台服务匹配单个精确 id，因此这样 POST 的名称不会拆错工作组。
  | { kind: "passthrough"; handle: string };

/**
 * 把 `rig down` 句柄（工作组名或 id）解析为具体工作组 id，与 `rig up`
 * 使用的 `/api/rigs/summary` 路径对应。解析是前置步骤：现有的拆除 + 下游守卫
 * 不变；这里只把句柄映射到 id。
 *
 * 安全顺序（破坏性操作）：
 *  1. 先做 id 精确匹配，跨所有工作组（含已归档）—— id 唯一，因此绝不歧义，
 *     已归档工作组的 id 仍能到达规范的拆除 id 路径（AC-2 不变）。
 *  2. 否则只在活跃（未归档）工作组上按名称过滤：
 *     - 恰好 1 个活跃匹配 -> 解析为该 id；
 *     - >1 个活跃匹配      -> 歧义：中止，绝不猜测（承重 AC-3）；
 *     - 0 个活跃匹配       -> 未找到：中止，诚实错误（AC-4）。
 *
 * `/api/rigs/summary` 默认只返回活跃并暴露 `archivedAt`；我们带
 * `includeArchived=true` 抓取，使已归档 id 仍能 id 匹配，再把名称过滤为活跃。
 * 因此同名的活跃+已归档配对不歧义（只算活跃候选），而已归档独占的名称无法
 * 按名称解析（请用 id，或走归档路径）。
 */
async function resolveRigHandle(client: DaemonClient, handle: string): Promise<HandleResolution> {
  let summaries: RigSummaryEntry[];
  try {
    // includeArchived=true，使已归档工作组的 id 仍能在下面 id 匹配
    // （保留今天的 `rig down <id>` 路径）；名称则过滤为活跃。
    const res = await client.get<RigSummaryEntry[]>("/api/rigs/summary?includeArchived=true");
    if (res.status !== 200 || !Array.isArray(res.data)) {
      return { kind: "passthrough", handle };
    }
    summaries = res.data;
  } catch {
    return { kind: "passthrough", handle };
  }

  // 1. 先做 id 精确匹配，跨所有工作组（含已归档）（AC-2：按 id 拆除，
  //    不变；id 绝不歧义；已归档 id 仍能到达拆除）。
  if (summaries.some((r) => r.id === handle)) {
    return { kind: "resolved", id: handle };
  }

  // 2. 只在活跃（未归档）工作组上按名称过滤，与 `up` 对称。
  const activeNameMatches = summaries.filter((r) => r.name === handle && r.archivedAt == null);
  if (activeNameMatches.length === 1) {
    return { kind: "resolved", id: activeNameMatches[0]!.id };
  }
  if (activeNameMatches.length > 1) {
    return { kind: "ambiguous", name: handle, ids: activeNameMatches.map((r) => r.id) };
  }
  return { kind: "not_found", handle };
}

/**
 * `rig down <rig>` —— 按名称或 id 拆除一个工作组。
 * @param depsOverride - 可注入的测试依赖
 * @returns Commander 命令
 */
export function downCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("down").description("拆除一个工作组");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig>", "要拆除的工作组名或 id")
    .option("--delete", "停止后删除工作组记录")
    .option("--force", "立即结束会话")
    .option("--snapshot", "拆除前拍快照")
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上运行")
    .action(async (rigHandle: string, opts: { delete?: boolean; force?: boolean; snapshot?: boolean; json?: boolean; host?: string }) => {
      // OPR.0.4.6.MH1 FR-2：选定主机路由——显式 --host 优先；
      // 否则已持久化的选择喂给随附的 --host 路径；无选择则与今天完全一致。
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();

      if (opts.host) {
        const { runRemoteHttpOp, resolveRemoteRigId } = await import("../remote-host-ops.js");
        const rigIdResult = await resolveRemoteRigId(opts.host, rigHandle, deps);
        if (!rigIdResult.ok) {
          if (opts.json) console.log(JSON.stringify(rigIdResult));
          else console.error(`错误：${rigIdResult.error}`);
          process.exitCode = 1;
          return;
        }
        const result = await runRemoteHttpOp(opts.host, "POST", `/api/down`, { rigId: rigIdResult.rigId, delete: opts.delete, force: opts.force, snapshot: opts.snapshot }, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`主机 ${opts.host} 上出错：${result.error}`);
          process.exitCode = 1;
        }
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // 在拆除 POST 之前把句柄（名称或 id）解析为具体 id。
      // 歧义/未找到在此处中止，绝不走到 `/api/down`——对破坏性操作，
      // 歧义必须停下，绝不猜测（AC-3 承重）。
      const resolution = await resolveRigHandle(client, rigHandle);

      if (resolution.kind === "ambiguous") {
        const fact = `'${resolution.name}' 匹配到 ${resolution.ids.length} 个工作组。`;
        const consequence = "拒绝拆除：歧义名称可能拆错工作组。";
        const action = `请用具体 id 重新运行，例如 ${resolution.ids.map((id) => `zrig down ${id}`).join("  |  ")}`;
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action, candidates: resolution.ids } }));
        } else {
          console.error(`错误：${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      if (resolution.kind === "not_found") {
        const fact = `未找到匹配 '${resolution.handle}' 的工作组。`;
        const consequence = "未拆除任何东西。";
        const action = "用以下命令列工作组：zrig ps";
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action } }));
        } else {
          console.error(`错误：${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      // resolved -> 查得的 id；passthrough -> 原始句柄（摘要
      // 不可用；后台服务按精确 id 解析，缺失则 404）。无论哪种，
      // 下面都跑同一条既有拆除路径 + 守卫——不分叉路径。
      const rigId = resolution.kind === "resolved" ? resolution.id : resolution.handle;

      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        rigId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) {
          process.exitCode = 2;
        } else {
          const r = res.data as TeardownResult;
          if (r.errors && r.errors.length > 0) process.exitCode = 2;
          else if (r.alreadyStopped && !r.deleted) process.exitCode = 1;
        }
        return;
      }

      // HTTP 错误
      if (res.status >= 400) {
        const errMsg = (res.data as { error: string }).error ?? "未知错误";
        console.error(`拆除失败：${errMsg}（HTTP ${res.status}）。用以下命令查看工作组 ID：zrig ps`);
        process.exitCode = 2;
        return;
      }

      const result = res.data as TeardownResult;

      // 退出码：先 errors，再 deleted，再 alreadyStopped
      if (result.errors.length > 0) {
        console.log(`工作组 ${rigId}：已结束 ${result.sessionsKilled} 个会话`);
        if (result.deleted) console.log("工作组已删除");
        if (result.snapshotId) console.log(`快照：${result.snapshotId}`);
        for (const e of result.errors) console.error(`  警告：${e}`);
        process.exitCode = 2;
        return;
      }

      if (result.deleted) {
        console.log(`工作组 ${rigId} 已删除。已结束 ${result.sessionsKilled} 个会话。`);
        if (result.snapshotId) console.log(`快照：${result.snapshotId}`);
        return;
      }

      if (result.alreadyStopped) {
        console.log(`工作组 ${rigId} 已停止`);
        process.exitCode = 1;
        return;
      }

      // 干净停止 + 命令后交接
      console.log(`工作组 ${rigId} 已停止。已结束 ${result.sessionsKilled} 个会话。`);
      if (result.snapshotId) {
        console.log(`快照：${result.snapshotId}`);
        // 命令后交接：如何恢复（检查是否重名）
        const rigName = (res.data as Record<string, unknown>)["rigName"] as string | undefined;
        const isUniqueName = (res.data as Record<string, unknown>)["isUniqueName"] as boolean | undefined;
        if (rigName && isUniqueName !== false) {
          console.log(`恢复方式：zrig up ${rigName}`);
        } else {
          console.log(`恢复方式：zrig restore ${result.snapshotId} --rig ${rigId}`);
        }
      }
    });

  return cmd;
}
