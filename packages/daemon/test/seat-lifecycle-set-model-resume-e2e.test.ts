// S5 修复第 1 轮，r2-F4（行 30045f39）——证明项 1 的真实 resume 分支：`set-model` 后，真实托管
// 继任者（SeatHandoverService + 真实 CodexRuntimeAdapter + 真实 codex TUI）在保留 session lineage
// 的情况下运行 canonical（set-model 后）模型。以 seat-handover-model-fidelity-e2e 为蓝本
//（D15 隔离：每次运行专属 -L socket、env 去掉 $TMUX、按 session 名拆除、绝不 kill-server；
// tmux/codex/auth 缺失时跳过）。
//
// 判别项：节点创建时固定到 runtime 默认值（gpt-5.6-sol），set-model 将其切换到有效的非默认值
//（gpt-5.6-luna）。继任者 footer 显示 luna，只可能来自更新后的 nodes.model 在调用时经真实 launcher
// 传递；回退或陈旧读取会显示 sol。
//
// 证据等级说明（真实）：这是 EVIDENCE 分支，不是缺陷修复；机制原本正确，所以没有对应 RED。它把
// 证明项 1 从引用+持久化加强为实际驱动的真实 resume。
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
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

const pexec = promisify(execFile);
const SOCK = `openrig-s5f4-e2e-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
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

const CREATED_MODEL = "gpt-5.6-sol";  // the runtime default — what a stale/reverted read shows
const CANONICAL_MODEL = "gpt-5.6-luna"; // set-model target; footer renders it verbatim only via the updated pin

function preflightOk(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" });
    execFileSync("sh", ["-c", "command -v codex"], { env: cleanEnv, stdio: "ignore" });
    return fs.existsSync(nodePath.join(os.homedir(), ".codex", "auth.json"));
  } catch { return false; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function realFsOps(): any {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    listFiles: (dir: string) => fs.readdirSync(dir),
    statMode: (p: string) => fs.statSync(p).mode,
    chmod: (p: string, m: number) => fs.chmodSync(p, m),
    homedir: os.homedir(),
  };
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // BY NAME, never kill-server
});

describe("S5 F4：set-model 后真实托管继任者运行 canonical 模型（真实 codex、隔离 tmux）", () => {
  it.runIf(preflightOk())(
    "the successor's EFFECTIVE model is the post-set-model canonical pin, and lineage survives",
    async () => {
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      const SEAT = "dev-impl@s5f4-rig";
      seats.push(SEAT);
      const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s5f4-e2e-"));
      execFileSync("sh", ["-c", `cd ${q(cwd)} && git init -q`], { env: cleanEnv });
      const queueRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs", "rigs", "s5f4-rig", "state", "dev");
      fs.mkdirSync(queueRoot, { recursive: true });

      await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
      await tmux(`new-session -d -s ${q(SEAT)} -x 120 -y 34 -c ${q(cwd)}`);
      await sleep(200);
      const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("s5f4-rig");
      // 创建时固定到 DEFAULT，即陈旧读取会传递的值。
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd, model: CREATED_MODEL });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-26T07:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const realTmux = new TmuxAdapter(exec);

      // 被证明的动作：创建之后、托管继任者之前执行 set-model。
      const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
      const setResult = await lifecycle.setModel({
        seatRef: SEAT, model: CANONICAL_MODEL,
        reason: "F4 real-resume proof: default -> canonical", operator: "dev50-driver@test",
      });
      expect(setResult.ok).toBe(true);
      if (!setResult.ok) throw new Error(setResult.message);
      expect(setResult.from).toBe(CREATED_MODEL);
      expect(setResult.to).toBe(CANONICAL_MODEL);

      const tenuresBefore = (db.prepare("SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?").get(node.id) as { c: number }).c;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const codexAdapter = new CodexRuntimeAdapter({ tmux: realTmux as any, fsOps: realFsOps() as any, listProcesses: () => [] }) as any;
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tmuxAdapter: realTmux as any, runtimeAdapters: { codex: codexAdapter },
        predecessorRecapResolver: () => null,
        readinessTimeoutMs: 90000, sleep,
      });

      const trustApprover = (async () => {
        for (let i = 0; i < 85; i++) {
          await sleep(1000);
          const c = await tmux(`capture-pane -p -t ${q(pane)}`).catch(() => "");
          if (/Do you trust the contents of this directory/.test(c)) {
            await tmux(`send-keys -t ${q(pane)} Enter`).catch(() => {});
            return;
          }
        }
      })();

      // 真实托管继任者：launch 路径在调用时读取 nodes.model。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await service.handover({ seatRef: SEAT, reason: "F4 real-resume proof", source: "fresh", operator: "dev50-driver@test" });
      await trustApprover.catch(() => {});
      await sleep(3000);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
      const footer = cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l) && l.includes(nodePath.basename(cwd)))
        ?? cap.split("\n").reverse().find((l) => /gpt-[\w.-]+ \S+ · \//.test(l));
      // eslint-disable-next-line no-console
      console.log("[s5f4-e2e] handover result.ok=" + result.ok + " code=" + (result.code ?? "-") + " footer=" + JSON.stringify(footer));

      expect(result.ok, "handover completed (successor became a ready agent)").toBe(true);
      expect(cap, "no invalid-model rejection / fallback in the successor").not.toMatch(/invalid_request_error|model is not|Model metadata for .* not found/);
      expect(footer, "successor rendered an effective-model footer").toBeTruthy();
      // 效果（F4）：真实继任者的有效模型是 set-model 后的 canonical 值……
      expect(footer, "successor EFFECTIVE model is the post-set-model canonical pin").toContain(CANONICAL_MODEL);
      // ……而不是陈旧/回退读取会传递的创建时值。
      expect(footer, "successor did NOT run the creation-time model").not.toContain(CREATED_MODEL);

      // LINEAGE 保留：前任 session 行完整（superseded 而未删除）；tenure ledger 增加 handover
      // generation，先前行不受影响。
      const rows = db.prepare("SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id").all(node.id) as Array<{ id: string; status: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.some((r) => r.id === session.id)).toBe(true);
      const tenuresAfter = (db.prepare("SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?").get(node.id) as { c: number }).c;
      expect(tenuresAfter).toBe(tenuresBefore + 1);
      // set-model 的 audit event 与 handover record 一起持久保留。
      const audit = db.prepare("SELECT COUNT(*) AS c FROM events WHERE type='node.model_changed'").get() as { c: number };
      expect(audit.c).toBe(1);

      db.close();
    },
    120_000,
  );
});
