import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// OPR.0.5.5.5——针对隔离 tmux server 的两个新增可执行 handover source 端到端关键证明
//（与 seat-handover-cutover-e2e 使用相同 D15 隔离纪律：每次运行使用独立 -L socket，不设置
// $TMUX，按 session 名 teardown，绝不 kill-server；tmux 不可用时跳过）。
//
// FORK：执行真实 cutover，已解析 native id 到达 launch surface（marker adapter 将收到的
// forkSource 渲染到真实 pane），证明 fork 执行是 native-fork launch，而不是重新标记的空白 fresh
// launch。REBUILD：解析真实磁盘 artifact 链，并实际投递 priming packet（在 pane 中可见），结果中
// 记录已执行集合。

const pexec = promisify(execFile);
const SOCK = `openrig-s05e2e-${process.pid}`;
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
const tempDirs: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {}); // 按名称，绝不 kill-server。
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort。 */ } }
});

async function seedPane(seat: string): Promise<string> {
  seats.push(seat);
  await tmux(`kill-session -t ${q(seat)}`).catch(() => {});
  await tmux(`new-session -d -s ${q(seat)} -x 110 -y 24`);
  await sleep(200);
  const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  // 新建 shell 在初始化期间可能吞掉早期 send-keys，因此轮询至 predecessor sentinel 确实渲染，
  // 使 cutover 后的 scrollback 断言测试保留行为，而非 send-keys 时序。
  for (let attempt = 0; attempt < 10; attempt++) {
    await tmux(`send-keys -t ${q(pane)} -l -- ${q("echo predecessor_line_S05")}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await sleep(300);
    const pre = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);
    if (pre.includes("predecessor_line_S05")) break;
  }
  return pane;
}

describe("seat-handover source 执行 E2E（隔离 tmux）", () => {
  it.runIf(tmuxAvailableSync())(
    "FORK 端到端：已解析 native id 到达保留 pane 中的真实启动；continuity 记录 forked",
    async () => {
      const SEAT = "dev-impl@fork-e2e-rig";
      const pane = await seedPane(SEAT);

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("fork-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });
      // incumbent 的 native conversation id——fork 必须解析并携带的值。
      sessionRegistry.updateResumeToken(session.id, "codex_id", "native-e2e-abc123", "scrape");

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          // 将收到的 fork source 渲染到真实 pane；下方钉扎从 capture 读回，证明 id 穿过完整路径。
          const stamp = opts?.forkSource ? `FORKED_FROM_${opts.forkSource.value}` : "NO_FORK_SOURCE";
          await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q(`printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`)}`);
          await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
          return { ok: true, resumeToken: "post-fork-tok", resumeType: "codex_id" };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "context-wall", source: `fork:${SEAT}`, operator: "orch@e2e" });
      await sleep(400);
      const paneAfter = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      expect(result.ok, "执行 fork handover").toBe(true);
      expect(paneAfter, "pane id 相同（保留 seat identity）").toBe(pane);
      expect(cap, "已解析 native id 到达 launch surface").toContain("FORKED_FROM_native-e2e-abc123");
      // scrollback 保留（deep-history 关键证明）由 seat-handover-cutover-e2e 负责；fork 使用同一
      // respawn 路径。此文件锁定 S05 新增内容：native id 原地到达 launch。
      expect(result.result.currentStatus.continuityOutcome).toBe("forked");
      expect(result.result.sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: SEAT });
      db.close();
    },
    60_000,
  );

  it.runIf(tmuxAvailableSync())(
    "REBUILD 端到端：真实磁盘链通过真实投递初始化 successor；记录已执行集合；continuity 记录 rebuilt",
    async () => {
      const SEAT = "dev-impl@rebuild-e2e-rig";
      const pane = await seedPane(SEAT);

      // 磁盘上的真实持久链：RECAP.md 存在，LEARNED.md 有意缺席，同时端到端证明 gap 分支。
      const seatDir = mkdtempSync(join(tmpdir(), "s05-rebuild-e2e-"));
      tempDirs.push(seatDir);
      writeFileSync(join(seatDir, "RECAP.md"), "# RECAP\nS05 e2e recap body\n");
      const recapAddress = join(seatDir, "RECAP.md");
      const learnedAddress = join(seatDir, "LEARNED.md"); // 未写入——真实 gap。

      const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("rebuild-e2e-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/tmp" });
      const session = sessionRegistry.registerSession(node.id, SEAT);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });

      const marker = {
        runtime: "codex",
        async launchHarness(binding: any, opts: any) {
          const stamp = opts?.forkSource || opts?.resumeToken ? "UNEXPECTED_NON_FRESH" : "FRESH_REBUILD_TARGET";
          await tmux(`send-keys -t ${q(binding.tmuxSession)} -l -- ${q(`printf '\\n=== SUCCESSOR ${stamp} ===\\n'; stty -echo 2>/dev/null; cat`)}`);
          await tmux(`send-keys -t ${q(binding.tmuxSession)} Enter`); await sleep(150);
          return { ok: true };
        },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: new TmuxAdapter(exec) as any, runtimeAdapters: { codex: marker as any },
        // 生产结构 resolver：声明 address；service 根据真实文件系统（默认 existsSync）过滤是否存在。
        rebuildPrimingResolver: () => ({
          artifacts: [
            { address: recapAddress, label: "authored seat recap (highest trust)" },
            { address: learnedAddress, label: "seat lineage lessons" },
          ],
        }),
        readinessTimeoutMs: 3000, sleep,
      });

      const result: any = await service.handover({ seatRef: SEAT, reason: "degraded-incumbent", source: "rebuild", operator: "orch@e2e" });
      await sleep(500);
      const cap = await tmux(`capture-pane -p -t ${q(pane)} -S -400`);

      expect(result.ok, "执行 rebuild handover").toBe(true);
      expect(cap, "successor 以 fresh 方式启动（无 fork/resume）").toContain("FRESH_REBUILD_TARGET");
      // priming packet 确实落入 pane 并指向 artifact。
      expect(cap, "端到端投递 priming packet").toContain("Seat rebuild handover");
      expect(cap, "投递已解析 artifact address").toContain(recapAddress);
      expect(result.result.currentStatus.continuityOutcome).toBe("rebuilt");
      expect(result.result.sourceOutcome).toMatchObject({
        mode: "rebuild",
        primedArtifacts: [expect.objectContaining({ address: recapAddress })],
        gaps: [learnedAddress],
      });
      db.close();
    },
    60_000,
  );
});
