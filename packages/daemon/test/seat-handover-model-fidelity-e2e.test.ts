import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import nodePath from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// 0.5.2-07——关键证明（EFFECT 环节，PM gate）。启动固定到低成本模型的 codex 席位，通过真实
// SeatHandoverService + 真实 CodexRuntimeAdapter 完成交接，再从实时 TUI 读取继任者的有效模型。
// 席位运行 SPEC 模型（gpt-5.1-codex-mini），而非 runtime 默认值（gpt-5.6-sol）。spec != default
// 是判别条件：继任者 footer 显示低成本模型，只可能来自 -m 经继任者 binding 传递（A2-1）；在 main
// 上交接会回退，footer 显示默认模型。这是效果而非指示器：真实 adapter 启动的真实 codex 进程报告
// 自身实际运行的模型。
//
// D15 隔离（[[real-run-e2e-daemon-isolation-doctrine]]、[[tmux-kill-server-from-seat-reaps-fleet]]）：
// 每条 tmux 命令使用本次运行专属的 `-L` socket（覆盖 $TMUX），完整环境减去 $TMUX/$TMUX_TMPDIR；
// 先验证隔离，按 session 名拆除，绝不 kill-server。tmux/codex/auth 缺失时跳过。

const pexec = promisify(execFile);
const SOCK = `openrig-mf-e2e-${process.pid}`;
const cleanEnv: any = { ...process.env };
delete cleanEnv.TMUX;
delete cleanEnv.TMUX_TMPDIR;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  const { stdout } = await pexec("sh", ["-c", safe], { env: cleanEnv });
  return stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SPEC_MODEL 是有效的非默认模型，codex 会在 effective-model footer 中逐字渲染它（无 400、无
// 静默回退）。DEFAULT_MODEL 是回退交接会显示的 codex runtime 默认值（fleet）。证明从持久 footer
//（"gpt-X <tier> · <cwd>"）读取有效模型，而非 banner 回显（"model: X /model to change"）；
// banner 可能显示 API 随后拒绝并回退的请求模型，这正是 indicator-vs-effect 陷阱。
const SPEC_MODEL = "gpt-5.6-luna"; // valid, distinct from the default; footer shows it verbatim
const DEFAULT_MODEL = "gpt-5.6-sol"; // the no-flag runtime default — the reverted-handover failure mode

function preflightOk(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" });
    execFileSync("sh", ["-c", "command -v codex"], { env: cleanEnv, stdio: "ignore" });
    return fs.existsSync(nodePath.join(os.homedir(), ".codex", "auth.json"));
  } catch { return false; }
}

function realFsOps() {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    listFiles: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, m: number) => fs.chmodSync(p, m),
    homedir: os.homedir(),
  } as any;
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
});

describe("席位交接模型保真关键证明（真实 codex、隔离 tmux）", () => {
  it.runIf(preflightOk())(
    "the successor runs on the SPEC-pinned model, not the runtime default",
    async () => {
      // 隔离优先：-L socket 绝不能显示 fleet 席位。
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      const SEAT = "dev-impl@mf-rig";
      seats.push(SEAT);
      // 使用包含 .git 的真实 cwd，使 adapter 的 `--add-dir <cwd>/.git` 指向真实路径。
      const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mf-e2e-"));
      execFileSync("sh", ["-c", `cd ${q(cwd)} && git init -q`], { env: cleanEnv });

      // codex adapter 会追加从席位名派生的 `--add-dir <queue-state-root>`。若该目录不存在，codex 会
      // 静默把 -m 降级到回退 tier（值得单独记录的真实特性：缺失 queue 目录会丢失 pin）。生产环境会
      // 保证该目录存在；此处创建它，使 -m 生效且继任者准确渲染固定模型。
      const queueRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs", "rigs", "mf-rig", "state", "dev");
      fs.mkdirSync(queueRoot, { recursive: true });

      await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
      await tmux(`new-session -d -s ${q(SEAT)} -x 120 -y 34 -c ${q(cwd)}`);
      await sleep(200);
      const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("mf-rig");
      // 固定项：席位由 spec 固定到低成本模型。
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd, model: SPEC_MODEL });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const realTmux = new TmuxAdapter(exec) as any;
      // 真实 adapter：createSuccessor 的 binding（经 A2-1 携带 spec model）流经真实 fresh-launch
      // 命令构造，该命令会输出 -m。
      const codexAdapter = new CodexRuntimeAdapter({ tmux: realTmux, fsOps: realFsOps(), listProcesses: () => [] }) as any;

      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: realTmux, runtimeAdapters: { codex: codexAdapter },
        predecessorRecapResolver: () => null, // no recap typed — keep the successor TUI clean for the footer read
        // readiness 验证轮询真实继任者，直到它成为可交互 agent。Codex 约 8 秒启动后显示
        // workspace-trust gate；生产中的可信 workspace 或操作员会批准它。下方并发模拟该批准，使
        // readiness 窗口观察到真正就绪的 agent；交接的 not-ready 信号是真实的而非假阴性，因此必须
        // 让继任者真正就绪，不能绕过它断言。
        //
        // 使用 90 秒而非 30 秒（5.2-cut 后根因，2026-08-22）：在这台 4 核机器的全套测试条件下，
        // 继任者约 30 秒才就绪（实测套件内通过点为 29,997ms，仅比旧上限少 3ms），安静机器上则约
        // 8 秒，因此 30 秒恰好落在负载下启动时间上，测试因时序而非产品失败（每次失败都显示 service
        // 真实的 not-ready，每次绿色运行都逐字渲染固定模型）。单独合成 loadavg 29 无法复现；机制是
        // 套件的进程/API 争用，而非 CPU。余量应放在测试中，service 默认值保持不变。
        readinessTimeoutMs: 90000, sleep,
      });

      // 在 readiness 窗口期间批准 codex workspace-trust gate（生产中由可信 workspace/操作员提供）。
      // 间隔发送 Enter 可覆盖启动时序差异。仅在条件满足时批准 trust gate：轮询提示，出现时恰好发送
      // 一次 Enter，然后停止。（无条件或重复 Enter 会在 codex 解析中途过度导航，并可能切换有效模型；
      // 这是本证明必须避免的真实陷阱。）
      const trustApprover = (async () => {
        // 85 次轮询，对齐 90 秒 readiness 窗口：在套件高负载下，trust gate 本身可能很晚出现；若
        // 批准器在 25 秒放弃，会恰好在最需要上述 readiness 余量的情况下让其无法触达。
        for (let i = 0; i < 85; i++) {
          await sleep(1000);
          const c = await tmux(`capture-pane -p -t ${q(pane)}`).catch(() => "");
          if (/Do you trust the contents of this directory/.test(c)) {
            await tmux(`send-keys -t ${q(pane)} Enter`).catch(() => {});
            return;
          }
        }
      })();

      const result: any = await service.handover({ seatRef: SEAT, reason: "tiering", source: "fresh", operator: "orch@seat" });
      await trustApprover.catch(() => {});
      await sleep(3000);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      // EFFECTIVE-model 行是持久 footer "gpt-<name> <tier> · <cwd>"，而非 banner
      // "model: X /model to change"（即使 API 拒绝请求模型且 codex 回退，banner 仍会回显请求模型；
      // 这是 indicator-vs-effect 陷阱）。读取本次运行 cwd 对应的 footer。
      const footer = cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l) && l.includes(nodePath.basename(cwd)))
        ?? cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l));
      // eslint-disable-next-line no-console
      console.log("[mf-e2e] handover result.ok=" + result.ok + " code=" + (result.code ?? "-"));
      // eslint-disable-next-line no-console
      console.log("[mf-e2e] EFFECTIVE footer: " + JSON.stringify(footer));

      expect(result.ok, "handover completed (successor became a ready agent)").toBe(true);
      // 不允许静默回退：此证明中的 pin 必须有效；被拒模型属于 A3 情况，不属于本测试。
      expect(cap, "no invalid-model rejection / fallback in the successor").not.toMatch(/invalid_request_error|model is not|Model metadata for .* not found/);
      expect(footer, "successor rendered an effective-model footer").toBeTruthy();
      // 效果：继任者的有效模型（footer）是 SPEC pin……
      expect(footer, "successor EFFECTIVE model is the SPEC pin").toContain(SPEC_MODEL);
      // ……而不是 runtime 默认值（main 上交接回退的失败模式）。
      expect(footer, "successor did NOT revert to the runtime default").not.toContain(DEFAULT_MODEL);

      db.close();
    },
    120_000,
  );
});
