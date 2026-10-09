/**
 * Slice 51-02（L2 测试系统）——shipped surface 读取器。
 *
 * 对 `expect` step，运行器经 SHIPPED `rig` 调用（或 TUI control socket）读命名 surface，
 * 返回可断言的 observable。只读——绝不直接戳 DB（诚实保证）。形状陷阱按 verify-at-source
 * 记录处理（ps/queue/stream 是裸数组；queue 用 --full 使 `body` 不被置空；tui_socket 是
 * unix socket，只发 `state`；policy provenance 是 `policy effective`）。
 *
 * RESERVED surface（PM lock 修订，裁决行 qitem-20260811092250-a80735bc）：`proof` 无
 * shipped 读 verb，因此 VALIDATOR 现在在加载时拒绝它（RESERVED_EXPECT_SURFACE）——它经
 * 类型化路径永远到不了本读取器。下面的 default 腿保留纵深防御的 UnboundSurfaceError，
 * 用于运行时偷渡的 reserved 值：unbound 绝不被静默跳过（fallback 需要显式成功信号）。
 */

import net from "node:net";
import { runRig } from "./scenario-daemon.js";
import type { ExpectSurface } from "./scenario-schema.js";

export interface SurfaceContext {
  rigBin: string;
  readEnv: Record<string, string | undefined>;
  baseUrl: string;
}

export interface ReadSurfaceOptions {
  /** surface 读所作用的席位（pane/transcript）。 */
  seat?: string;
  /** socket/CLI 读超时（ms）。 */
  timeoutMs?: number;
  /** scope 读审计的 mission（D3）：`rig scope audit` 把 --mission 作为 requiredOption，
   *  因此无它的 scope 读永远不能成功。来自 scenario 的 env.scope_mission（对 scope expect
   *  为 validator 必填）。 */
  scopeMission?: string;
  /** transcript 读 `--tail <lines>` 的行数（取值选项）。 */
  transcriptTail?: number;
}

/** transcript surface 读的默认 tail 深度。 */
export const DEFAULT_TRANSCRIPT_TAIL = 200;

/**
 * transcript surface 读的 argv。导出使测试能用读取器自己的 argv 驱动真实 CLI——matcher
 * 形状单测不跨的边界，也是 `--tail --json` 吞值藏身之处。
 */
export function transcriptReadArgv(seat: string, tail?: number): string[] {
  return ["transcript", seat, "--tail", String(tail ?? DEFAULT_TRANSCRIPT_TAIL), "--json"];
}

/** 当 `expect` 命名了一个 locked 但未绑定的 surface（FLAG-1 下限）时抛出。 */
export class UnboundSurfaceError extends Error {
  readonly surface: string;
  constructor(surface: string) {
    super(
      `expect surface "${surface}" 在 v1 未绑定：它是 locked 格式 surface，无 shipped 读绑定，` +
        `因此运行器在此 FAILS LOUD，而非编造一次读（绑定决策经修订随 51-03）。这不是被静默` +
        `跳过的断言。`,
    );
    this.name = "UnboundSurfaceError";
    this.surface = surface;
  }
}

/** 读 shipped surface 并返回其解析后的 observable。 */
export async function readSurface(
  surface: ExpectSurface,
  ctx: SurfaceContext,
  opts: ReadSurfaceOptions = {},
): Promise<unknown> {
  switch (surface) {
    case "ps":
      return jsonRig(["ps", "--json"], ctx);
    case "queue":
      // --full 使 compact-list 不置空 body/summary/evidenceRef。
      return jsonRig(["queue", "list", "--json", "--full"], ctx);
    case "stream":
      return jsonRig(["stream", "list", "--json"], ctx);
    case "scope": {
      // --mission 是 shipped 读（scope.ts）上的 requiredOption——此处缺意味着流水线未能把
      // env.scope_mission 穿过来。
      if (!opts.scopeMission) {
        throw new Error(
          `expect surface "scope" 需要 mission——声明 env.scope_mission（shipped 读是 \`rig scope audit --mission <name> --json\`）`,
        );
      }
      return jsonRig(["scope", "audit", "--mission", opts.scopeMission, "--json"], ctx);
    }
    case "pane":
      return jsonRig(["capture", requireSeat(surface, opts), "--json"], ctx);
    case "transcript":
      // `--tail <lines>` 取 REQUIRED 值：`--tail --json` 使 Commander 把 "--json" 当 tail
      // 值消费（{"tail":"--json"}），于是 JSON 模式从未设置，读返回人类文本。传显式 tail 数。
      return jsonRig(transcriptReadArgv(requireSeat(surface, opts), opts.transcriptTail), ctx);
    case "policy_provenance":
      return jsonRig(["policy", "effective", "--json"], ctx);
    case "tui_socket":
      return readTuiSocket(ctx, opts);
    default:
      // 纵深防御：经 cast 偷渡过 validator 的 RESERVED 值（例如 "proof"）仍 loud 且具名失败，
      // 绝不编造。
      if ((surface as string) === "proof") throw new UnboundSurfaceError("proof");
      throw new Error(`未知 expect surface：${JSON.stringify(surface)}`);
  }
}

function requireSeat(surface: string, opts: ReadSurfaceOptions): string {
  if (!opts.seat) throw new Error(`expect surface "${surface}" 需要 seat（expect.seat）`);
  return opts.seat;
}

async function jsonRig(args: string[], ctx: SurfaceContext): Promise<unknown> {
  const r = await runRig(args, ctx.readEnv, ctx.rigBin);
  if (r.code !== 0) {
    throw new Error(`\`rig ${args.join(" ")}\` 失败（exit ${r.code}）：${r.stderr || r.stdout}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`\`rig ${args.join(" ")}\` 未返回合法 JSON：${r.stdout.slice(0, 200)}`);
  }
}

/**
 * 查询 TUI control socket 的 OBSERVE verb：连接，只发 `state`，并解析单行 JSON 回复。
 * 发任何其他行都是 MUTATION——读取器只发 `state`。路径来自 OPENRIG_TUI_SOCKET（scenario
 * helper 在 TUI 起来时设置它）。
 */
function readTuiSocket(ctx: SurfaceContext, opts: ReadSurfaceOptions): Promise<unknown> {
  const sockPath = ctx.readEnv.OPENRIG_TUI_SOCKET;
  if (!sockPath) {
    return Promise.reject(
      new Error("tui_socket 读需要 OPENRIG_TUI_SOCKET（TUI control socket 路径）"),
    );
  }
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("tui_socket `state` 查询超时"));
    }, timeoutMs);
    conn.on("connect", () => conn.write("state\n"));
    conn.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      conn.end();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`tui_socket 回复不是 JSON：${line.slice(0, 120)}`));
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
