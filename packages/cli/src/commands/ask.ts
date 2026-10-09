import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveIdentitySource } from "./whoami.js";
import { runWake, defaultWakeRunner, defaultWakeFileLocator, type WakeRunner } from "../ask-wake.js";

interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

interface AskSeatEvidence {
  name: string;
  generations: number;
  hits: Array<{ generation: number; text: string }>;
  degraded?: { reason: string; message: string };
  advisory?: string;
}

interface AskSessionEvidence {
  token: string;
  found: boolean;
  path?: string;
  excerpts: string[];
  degraded?: { reason: string; message: string };
  advisory?: string;
}

interface CliKnownTenure {
  generation: number;
  sessionId: number;
  tokenPresent: boolean;
  createdAt: string;
}

type WakeResolution =
  | { resolved: true; token: string; runtime: "claude" | "codex"; sessionId: number }
  | { resolved: false; reason: string; known: CliKnownTenure[] };

/** 解析 --wake 的席位目标，末尾可带 @<generation>。席位写作
 *  `member@rig`（一个 @）；`member@rig@2` 表示第 2 代。只有末尾纯数字的
 *  @ 段才被视为代次。 */
function parseSeatGen(target: string): { seat: string; generation?: number } {
  const parts = target.split("@");
  const last = parts[parts.length - 1]!;
  if (parts.length >= 3 && /^\d+$/.test(last)) {
    return { seat: parts.slice(0, -1).join("@"), generation: Number(last) };
  }
  return { seat: target };
}

interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  seat?: AskSeatEvidence;
  session?: AskSessionEvidence;
  insufficient: boolean;
  guidance?: string;
}

interface AskCommandDeps extends StatusDeps {
  identityResolver?: typeof resolveIdentitySource;
  wakeRunner?: WakeRunner;
  wakeFileLocator?: (token: string) => { path: string; sizeBytes: number } | null;
}

export function askCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ask")
    .description("用自然语言问题检索工作组历史转录")
    .argument("<rig>", "要检索的工作组名")
    .argument("<question>", "要在转录中检索的问题")
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--seat <session-name>", "把检索限定到某一个席位在历任代次中的转录（跨代考古）")
    .option("--session <token>", "按会话 token 检索某一个会话的 JSONL（只读）")
    .option("--wake <seat[@gen]|token>", "会执行操作：唤醒会话（按 seat[@代次] 或原始 resume token）——问一个问题、得到快照回答后回到冷态（有运行时开销；显式触发，绝不从检索隐式升级）")
    .option("--runtime <runtime>", "--wake 使用的运行时：claude（默认）或 codex")
    .option("--wake-timeout <seconds>", "唤醒超时上限（秒，默认 180）")
    .addHelpText("after", `
zrig ask 是面向"过去信息"的单一动词，有三种到达方式：
  1. zrig ask <rig> "<q>"                    检索整个工作组的转录
  2. zrig ask <rig> "<q>" --seat <seat>      限定到某一个席位在历任
                                            代次中的转录（L1，只读）
  3. zrig ask <rig> "<q>" --session <token>  按 token 检索某一个会话的
                                            JSONL——"我有 token，找到它"（L2，只读）
  4. zrig ask <rig> "<q>" --wake <seat[@gen]|token>
                                            唤醒该会话（按 seat[@代次]
                                            或原始 token），提问、得到快照
                                            回答后回到冷态（L3，会执行）

L1-2 是只读考古（便宜、安全）。L3（--wake）会执行一个智能体——是唯一有运行时
开销的级别。回答是快照证词：经过核查，而非照单全信。

示例：
  zrig ask my-rig "部署相关做了哪些决策？"
  zrig ask my-rig "我们决定了什么" --seat dev-planner@my-rig
  zrig ask my-rig "SECRET_MARKER" --session 3f2a-...-9c1
  zrig ask my-rig "总结网关计划" --wake 3f2a-...-9c1

退出码：
  0  成功
  1  后台服务未运行
  2  从后台服务获取数据失败（或唤醒超时）`);

  const getDeps = (): AskCommandDeps => (depsOverride as AskCommandDeps | undefined) ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (rig: string, question: string, opts: { json?: boolean; seat?: string; session?: string; wake?: string; runtime?: string; wakeTimeout?: string }) => {
    const deps = getDeps();

    // L3 — WAKE：会无头执行运行时。原始 token 在 CLI 本地唤醒；
    // seat[@代次] 目标先经后台服务解析为 token。仅显式 --wake——
    // 绝不从失败的 L1/L2 检索隐式升级；无法解析的席位会带提示拒绝
    // （绝不猜测唤醒）。
    if (opts.wake) {
      const target = opts.wake;
      const timeoutMs = opts.wakeTimeout ? Math.max(1, Number(opts.wakeTimeout)) * 1000 : undefined;

      let token = target;
      let runtime: "claude" | "codex" = opts.runtime === "codex" ? "codex" : "claude";

      if (target.includes("@")) {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        // B8-1b 关键节点（missed-site 修复）：共享守卫渲染认知三段式；
        // 唤醒专属的兜底提示作为补充 tip 出现。
        if (!daemonStatusGuard(status)) {
          console.error("  提示：席位解析需要后台服务——或给 --wake 传原始会话 token。");
          return;
        }
        const client = deps.clientFactory(getDaemonUrl(status));
        const { seat, generation } = parseSeatGen(target);
        const res = await client.post<WakeResolution>("/api/wake-resolve", { seat, generation });
        if (res.status >= 400) {
          console.error(`席位解析失败（HTTP ${res.status}）。用 zrig status 检查后台服务状态。`);
          process.exitCode = 2;
          return;
        }
        const resolution = res.data;
        if (!resolution.resolved) {
          console.error(resolution.reason);
          if (resolution.known && resolution.known.length > 0) {
            console.error("该席位的已知任职记录（最新在前）：");
            for (const t of resolution.known) {
              console.error(`  第 ${t.generation} 代：会话 ${t.sessionId}${t.tokenPresent ? "" : "（无 resume token）"}  ${t.createdAt}`);
            }
          }
          process.exitCode = 2;
          return;
        }
        token = resolution.token;
        runtime = resolution.runtime;
      }

      const runner = deps.wakeRunner ?? defaultWakeRunner;
      const fileLocator = deps.wakeFileLocator ?? defaultWakeFileLocator;
      const outcome = await runWake({ runner, fileLocator }, { question, token, runtime, timeoutMs });

      if (opts.json) {
        console.log(JSON.stringify(outcome));
        if (outcome.timedOut || outcome.failed) process.exitCode = 2;
        return;
      }
      if (outcome.advisory) console.log(`⚠ ${outcome.advisory}`);
      if (outcome.timedOut || outcome.failed) {
        console.error(outcome.message);
        process.exitCode = 2;
        return;
      }
      console.log(`已唤醒 ${runtime} 会话 ${target}——快照回答（经过核查，而非照单全信）：`);
      console.log("");
      console.log(outcome.answer && outcome.answer.length > 0 ? outcome.answer : "（未返回回答）");
      return;
    }

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return;

    const client = deps.clientFactory(getDaemonUrl(status));
    const identity = (deps.identityResolver ?? resolveIdentitySource)({});
    const res = await client.post<AskResult>("/api/ask", {
      rig,
      question,
      nodeId: identity?.nodeId,
      sessionName: identity?.sessionName,
      seat: opts.seat,
      session: opts.session,
    });

    if (res.status >= 400) {
      console.error(`查询工作组失败（HTTP ${res.status}）。用 zrig status 检查后台服务状态。`);
      process.exitCode = 2;
      return;
    }

    const result = res.data;

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }

    // 人类可读输出
    console.log(`问题：${result.question}`);
    console.log("");

    if (result.rig) {
      console.log(`工作组：${result.rig.name}  [${result.rig.status}]  ${result.rig.runningCount}/${result.rig.nodeCount} 个节点  运行时长：${result.rig.uptime ?? "—"}`);
    } else {
      console.log(`工作组：${rig}  [未找到]`);
    }

    if (result.seat) {
      console.log(`席位：${result.seat.name}（已检索 ${result.seat.generations} 代）`);
      if (result.seat.advisory) {
        console.log(`  ⚠ ${result.seat.advisory}`);
      }
    }

    if (result.session) {
      const loc = result.session.found ? (result.session.path ?? "已找到") : "未找到";
      console.log(`会话：${result.session.token}  [${loc}]`);
      if (result.session.advisory) {
        console.log(`  ⚠ ${result.session.advisory}`);
      }
    }

    console.log(`检索后端：${result.evidence.backend}`);
    console.log("");

    if (result.guidance) {
      console.log(result.guidance);
      console.log("");
    }

    if (result.evidence.excerpts.length > 0) {
      const heading = result.evidence.backend === "structured"
        ? `结构化回答（${result.evidence.excerpts.length} 条）：`
        : `转录证据（${result.evidence.excerpts.length} 处匹配）：`;
      console.log(heading);
      for (const excerpt of result.evidence.excerpts) {
        console.log(`  - ${excerpt}`);
      }
    }

    if (result.evidence.chatExcerpts && result.evidence.chatExcerpts.length > 0) {
      if (result.evidence.excerpts.length > 0) {
        console.log("");
      }
      console.log(`聊天证据（${result.evidence.chatExcerpts.length} 处匹配）：`);
      for (const excerpt of result.evidence.chatExcerpts) {
        console.log(`  - ${excerpt}`);
      }
    }

    if (
      result.evidence.excerpts.length === 0 &&
      (!result.evidence.chatExcerpts || result.evidence.chatExcerpts.length === 0) &&
      !result.guidance
    ) {
      console.log("未找到转录证据。");
    }
  });

  return cmd;
}
