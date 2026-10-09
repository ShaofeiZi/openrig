import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareHermeticEnv,
  assertNoAmbientTmux,
  detectAmbientTmuxHazard,
  AmbientTmuxHazardError,
  TMUX_ATTACHMENT_ENV_VARS,
  type HermeticScaffold,
} from "./helpers/hermetic-env.js";

// 51-02 delta D5（advisor 裁定，guard precision pin）——TMUX 隔离。
//
// scenario `up` 会启动真实 tmux seat。仅有 TMUX_TMPDIR 不是 identity：其目录消失后，后续 command
// 可能解析到其他位置。因此 helper 用一个显式 private socket 包装每次 child invocation，并在创建任何
// 内容前拒绝 ambient attachment。

const scaffolds: HermeticScaffold[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of scaffolds.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cleanBase = () => ({ HOME: "/tmp/whatever", PATH: process.env.PATH, TERM: "xterm" });

describe("D5 p1——ambient TMUX attachment 在任何副作用前被拒绝", () => {
  it("将 TMUX 检测为独立具名 hazard 类别（不是 daemon target，也不是 clock）", () => {
    expect(TMUX_ATTACHMENT_ENV_VARS as readonly string[]).toContain("TMUX");
    const h = detectAmbientTmuxHazard({ TMUX: "/private/tmp/tmux-501/default,12345,0" });
    expect(h).not.toBeNull();
    expect(h!.name).toBe("TMUX");
    expect(() => assertNoAmbientTmux({ TMUX: "/tmp/x,1,0" })).toThrow(AmbientTmuxHazardError);
    expect(detectAmbientTmuxHazard(cleanBase())).toBeNull();
    expect(detectAmbientTmuxHazard({ TMUX: "" })).toBeNull(); // exported-but-empty is absent
  });

  it("以点名 fleet hazard 的消息拒绝，且不创建 scaffold dir", () => {
    // 在 private temp root 中测量：scaffold 创建于 os.tmpdir()，它每次调用都会读取 TMPDIR，因此将其
    // 指向自有目录，可使 pre-effect 断言不受其他 suite 在共享 /tmp 中行为的影响（统计 shared dir
    // 会造成自发 contention flake）。
    const priv = mkdtempSync(join(tmpdir(), "tmux-preeffect-"));
    dirs.push(priv);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    let msg = "";
    try {
      expect(() => {
        try {
          prepareHermeticEnv({ baseEnv: { ...cleanBase(), TMUX: "/private/tmp/tmux-501/default,999,0" } });
        } catch (e) {
          msg = (e as Error).message;
          throw e;
        }
      }).toThrow(AmbientTmuxHazardError);
      // pre-effect：private root 仍为空——未创建 scaffold
      expect(readdirSync(priv)).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    expect(msg).toContain("TMUX");
    expect(msg.toLowerCase()).toContain("server");
  });
});

describe("D5 p2——inherited TMUX_TMPDIR 不出现在 child 中，并由 scaffold 自有值替换", () => {
  it("独立证明两个部分", () => {
    const inherited = mkdtempSync(join(tmpdir(), "ambient-tmux-"));
    try {
      const s = prepareHermeticEnv({ baseEnv: { ...cleanBase(), TMUX_TMPDIR: inherited } });
      scaffolds.push(s);
      // (a) inherited value 已移除
      expect(s.env.TMUX_TMPDIR).not.toBe(inherited);
      // (b) 由 scaffold 自有且已存在的 directory 替换
      expect(s.env.TMUX_TMPDIR).toBe(s.tmuxTmpDir);
      expect(s.tmuxTmpDir.startsWith(s.root)).toBe(true);
      expect(existsSync(s.tmuxTmpDir)).toBe(true);
    } finally {
      rmSync(inherited, { recursive: true, force: true });
    }
  });

  it("即使 base env 不含 TMUX_TMPDIR，也会设置自有 TMUX_TMPDIR", () => {
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    scaffolds.push(s);
    expect(s.env.TMUX_TMPDIR).toBe(s.tmuxTmpDir);
    expect(s.tmuxTmpDir.startsWith(s.root)).toBe(true);
    expect(existsSync(s.tmuxTmpDir)).toBe(true);
    // cleanup 连同其他内容一起移除 scaffold-owned server dir
    s.cleanup();
    expect(existsSync(s.tmuxTmpDir)).toBe(false);
  });

  it("保持 socket path 足够短，以适配 sun_path（约 104 byte）", () => {
    const s = prepareHermeticEnv({ baseEnv: cleanBase() });
    scaffolds.push(s);
    expect(Buffer.byteLength(s.tmuxSocketPath)).toBeLessThan(104);
  });

  it("cleanup 终止重复的 scaffold-owned tmux server，且不触碰无关 server", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const sentinelDir = mkdtempSync(join(tmpdir(), "sent-cleanup-"));
    const sentinelSocketPath = join(sentinelDir, "sentinel.sock");
    dirs.push(sentinelDir);

    const directEnv = () => {
      const env = { ...process.env } as NodeJS.ProcessEnv;
      delete env.TMUX;
      delete env.TMUX_TMPDIR;
      return env;
    };
    const at = (socketPath: string, args: string[]) =>
      run("tmux", ["-S", socketPath, ...args], { env: directEnv() });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await at(sentinelSocketPath, ["new-session", "-d", "-s", "unrelated", "sleep 600"]);
    const sentinelPid = Number(
      (await at(sentinelSocketPath, ["display-message", "-p", "-t", "unrelated", "#{pid}"])).stdout.trim(),
    );
    try {
      for (const runNumber of [1, 2]) {
        const s = prepareHermeticEnv({
          baseEnv: { ...cleanBase(), TMUX_TMPDIR: sentinelDir },
        });
        scaffolds.push(s);
        const session = `scenario-${runNumber}`;
        await run("tmux", ["new-session", "-d", "-s", session, "sleep 600"], {
          env: s.env as NodeJS.ProcessEnv,
        });
        const server = await run("tmux", ["display-message", "-p", "-t", session, "#{pid}"], {
          env: s.env as NodeJS.ProcessEnv,
        });
        const serverPid = Number(server.stdout.trim());

        s.cleanup();
        s.cleanup();
        expect(existsSync(s.root)).toBe(false);
        await vi.waitFor(() => {
          expect(alive(serverPid)).toBe(false);
        }, { timeout: 2_000, interval: 25 });
        const sentinel = await at(sentinelSocketPath, ["list-sessions", "-F", "#{session_name}"]);
        expect(sentinel.stdout.trim()).toBe("unrelated");
        const sentinelServer = await at(sentinelSocketPath, [
          "display-message", "-p", "-t", "unrelated", "#{pid}",
        ]);
        expect(Number(sentinelServer.stdout.trim())).toBe(sentinelPid);
      }
    } finally {
      await at(sentinelSocketPath, ["kill-session", "-t", "unrelated"]).catch(() => {});
    }
  });
});

// Guard finding 4：上一版只在以 `down` 结束的 run 后 snapshot 顶层 `tmux-*` directory name——
// 因此无法检测其声称要排除的 contamination（scenario 会自行 cleanup，而连接或修改现有 server
// 不会改变 name set）。falsification 证明该检查无效：即使禁用 TMUX_TMPDIR replacement 仍会通过。
//
// 此版本在 seat 存活时观测并双向断言：inherited sentinel server 没有新增内容，seat 实际位于显式
// scaffold socket。聚焦的 p2 cleanup proof 通过观察 owned server PID 存活，单独检测 socket shim
// 被移除的情况。
describe("D5 p3（integration）——替换 inherited tmux server，并在 seat 存活时证明", () => {
  it("seat 落在 scaffold-owned server；inherited sentinel server 没有新增内容", async () => {
    const { spawnScenarioDaemon, runRig } = await import("./helpers/scenario-daemon.js");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);

    const HERE = dirname(fileURLToPath(import.meta.url));
    const rigBin = resolve(HERE, "../../cli/dist/bin-wrapper.js");
    const sourceTopology = join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml");
    const pkgRoot = resolve(HERE, "..");

    const sentinelDir = mkdtempSync(join(tmpdir(), "sent-"));
    const sentinelDefaultDir = join(sentinelDir, `tmux-${process.getuid()}`);
    mkdirSync(sentinelDefaultDir, { recursive: true, mode: 0o700 });
    const sentinelSocketPath = join(sentinelDefaultDir, "default");
    dirs.push(sentinelDir);
    const directEnv = () => {
      const e = { ...process.env } as Record<string, string | undefined>;
      delete e.TMUX;
      delete e.TMUX_TMPDIR;
      return e as NodeJS.ProcessEnv;
    };
    const at = (socketPath: string, args: string[]) =>
      run("tmux", ["-S", socketPath, ...args], { env: directEnv() });
    const sessionsAt = async (socketPath: string): Promise<string> => {
      try {
        const { stdout } = await at(socketPath, ["list-sessions", "-F", "#{session_name}"]);
        return stdout.trim().split("\n").filter(Boolean).sort().join(",");
      } catch { return ""; } // no server = no sessions
    };

    await at(sentinelSocketPath, ["new-session", "-d", "-s", "sentinel-only", "sleep 600"]);
    const before = await sessionsAt(sentinelSocketPath);
    expect(before).toBe("sentinel-only"); // the sentinel is real and reachable

    // 通过真实 helper 继承 sentinel dir。
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", TMUX_TMPDIR: sentinelDir },
    });
    scaffolds.push(scaffold);
    expect(scaffold.env.TMUX_TMPDIR).toBe(scaffold.tmuxTmpDir);
    expect(scaffold.env.TMUX_TMPDIR).not.toBe(sentinelDir);

    // Guard finding 2：旧版对 seat 声明 `cwd: .` 的 topology 运行 `up`，但无 staged cwd、无 --cwd——
    // daemon 因此把 seat cwd 解析到 source tree，seat 随后向 packages/daemon 写 AGENTS.md 与
    // .openrig/stub/**。一边证明 tmux isolation、一边破坏 owner tree 的 pin 不是 hermeticity pin。
    // 改用 slice 自身的 staging helper 准备 per-seat scaffold cwd。
    const staged = stageTopologyRoot(sourceTopology, join(scaffold.root, "topology"));
    const managedInSource = () => [
      join(pkgRoot, "AGENTS.md"),
      join(pkgRoot, ".openrig"),
    ].filter((f) => existsSync(f));
    expect(managedInSource()).toEqual([]); // clean before

    const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    try {
      const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // seat 存活时（尚未 `down`）——双向验证：
      const ownedNow = await sessionsAt(scaffold.tmuxSocketPath);
      const sentinelNow = await sessionsAt(sentinelSocketPath);
      expect(ownedNow).toContain("scn-baton");   // seat 在这里……
      expect(sentinelNow).toBe(before);          // ...and the inherited server gained nothing
      expect(sentinelNow).not.toContain("scn-baton");

      // EFFECT PIN（guard finding 2）：source/launch tree 没有收到 managed seat 文件——seat 写入
      // 落在其应属的 scaffold 中。
      expect(managedInSource()).toEqual([]);
      const seatCwd = staged.seatCwds["dev-worker"]!;
      expect(existsSync(join(seatCwd, ".openrig", "stub", "state.json"))).toBe(true);
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await daemon.stop().catch(() => {});
      await at(sentinelSocketPath, ["kill-session", "-t", "sentinel-only"]).catch(() => {});
    }
  }, 300_000);
});
