import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// P14——seat-handover 切换已提交的关键证明 e2e（r1 的低优先级可选项；防范曾遇到的 tmux
// 版本回归：respawn-pane -k 会清除回滚内容，且在 env -i 下制表符会被净化为 "_"）。
// 针对隔离的 tmux server 驱动真实 handover（createSuccessor → terminateRetiree →
// respawn-no-k → commit），证明无论退役者优雅退出还是强制退出，前任回滚内容都会保留在
// 同一个 pane 中。
//
// D15 隔离（[[real-run-e2e-daemon-isolation-doctrine]]、[[tmux-kill-server-from-seat-reaps-fleet]]）：
// 每条 tmux 命令都使用逐运行 `-L` socket（覆盖 $TMUX），保留除 $TMUX 外的完整环境
//（env -i 会移除 locale 并破坏制表符分隔格式），先验证隔离，并按会话名称拆除——绝不
// kill-server。有守卫：tmux 不可用时跳过。

const pexec = promisify(execFile);
const SOCK = `openrig-e2e-${process.pid}`;
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

function tmuxAvailableSync(): boolean {
  try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; }
}

const seats: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // 按名称处理，绝不 kill-server
});

describe("seat-handover 切换关键证明（隔离 tmux，两种退役者退出路径）", () => {
  it.runIf(tmuxAvailableSync())(
    "在优雅和强制路径上，前任回滚内容都保留在同一 pane 中",
    async () => {
      // 首先验证隔离：-L socket 绝不能显示 fleet seat。
      const sessions = await tmux("list-sessions -F '#{session_name}'").catch(() => "");
      expect(sessions).not.toMatch(/dev-guard@|dev-planner@|orch-|review-/);

      for (const graceful of [true, false]) {
        const SEAT = `dev-impl@${graceful ? "graceful" : "forced"}-rig`;
        seats.push(SEAT);
        await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
        await tmux(`new-session -d -s ${q(SEAT)} -x 110 -y 24`);
        await sleep(200);
        const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
        // 优雅退出：设置 SIGTERM trap，使退役 shell 正常退出；强制退出：无 trap → 回退到 SIGKILL。
        if (graceful) { await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`); await tmux(`send-keys -t ${q(pane)} Enter`); }
        // 约 28 行前任内容 → 真实深度回滚（超过 24 行 pane）。
        for (let i = 1; i <= 28; i++) {
          await tmux(`send-keys -t ${q(pane)} -l -- ${q(`echo v1_line_${i}_atom_A5`)}`);
          await tmux(`send-keys -t ${q(pane)} Enter`);
        }
        await sleep(300);

        const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
        const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
        const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
        const rig = rigRepo.createRig(`${graceful ? "graceful" : "forced"}-rig`);
        const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
        const session = sessionRegistry.registerSession(node.id, SEAT);
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
        sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

        const marker = {
          runtime: "codex",
          async launchHarness(binding: any) {
            await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q("printf '\\n=== SUCCESSOR v2 in the SAME pane ===\\n'; stty -echo 2>/dev/null; cat")}`);
            await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
            return { ok: true, resumeToken: "tok", resumeType: "codex_id" };
          },
          async checkReady() { return { ready: true }; },
        };
        const service = new SeatHandoverService({
          db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
          tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
          predecessorRecapResolver: () => ({ recap: [{ role: "user", content: "完成 A5" }, { role: "assistant", content: "A5 已落地；移交给 v2" }], recordPath: "/tmp/pred-record.jsonl" }),
          readinessTimeoutMs: 3000, sleep,
        });

        // (i-a) 切换前捕获退役进程（pane 的 shell PID）——幽灵唤醒源（样本 5）是 gen-1
        // 的会话本地纯内存 cron，与此进程共生共灭。证明 handover 后退役者已终止，
        // 即可关闭该缺陷类别：进程消失后，会话本地自动化无法再触发。
        const retireePid = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_pid}'`)).trim();

        const result: any = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
        await sleep(500);
        const paneAfter = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
        const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
        const predLines = cap.split("\n").filter((l) => l.includes("v1_line_")).length;

        // 两条路径的关键证明：
        expect(result.ok, `${graceful ? "优雅" : "强制"} handover`).toBe(true);
        expect(paneAfter, "pane id 相同（回滚上下文）").toBe(pane);
        expect(predLines, "前任深层历史保留在原生回滚中").toBeGreaterThan(0);
        expect(cap, "后继在同一 pane 中启动").toContain("SUCCESSOR v2");
        expect(cap, "临时的记录回顾已触发").toContain("从记录重放");

        // (i-a) 关闭缺陷类别的固定点：handover 后退役进程已终止，因此其会话本地纯内存自动化
        //（进程内注册的 cron/timer——幽灵唤醒源）也随之终止。若回归导致退役者在切换后仍存活
        //（或未先终止便 respawn），此测试会变红。
        let retireeAlive = true;
        try { execFileSync("sh", ["-c", `kill -0 ${retireePid}`], { env: cleanEnv, stdio: "ignore" }); }
        catch { retireeAlive = false; }
        expect(retireeAlive, `${graceful ? "优雅" : "强制"}退出的退役进程（pid ${retireePid}）在 handover 后已终止——会话本地自动化随之终止`).toBe(false);
        db.close();
      }
    },
    60_000,
  );
});
