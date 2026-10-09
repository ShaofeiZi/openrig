import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import {
  readSurface,
  transcriptReadArgv,
  UnboundSurfaceError,
  type SurfaceContext,
} from "./helpers/scenario-surfaces.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const realBaseEnv = () => ({ HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" });

// Slice 51-02——surface reader：通过已发布的 `rig` 调用读取每个可观察 surface，并解析为 runner
// 断言的 observable。`proof` 在格式层被保留（PM lock 修正，裁定行
// qitem-20260811092250-a80735bc）；validator 在加载时拒绝它，reader 则为 runtime 偷渡值保留
// 纵深防御的 unbound 错误。

describe("surface reader——reserved-proof 纵深防御 + dispatch（纯）", () => {
  const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: {}, baseUrl: "http://127.0.0.1:1" };

  it("runtime 偷渡的 'proof' 读取仍以具名 UnboundSurfaceError 明确失败（纵深防御）", async () => {
    // "proof" 已离开 ExpectSurface 类型（RESERVED），只有类型转换能到达此处。
    const smuggled = "proof" as never;
    await expect(readSurface(smuggled, ctx)).rejects.toBeInstanceOf(UnboundSurfaceError);
    let msg = "";
    try { await readSurface(smuggled, ctx); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("proof");
    expect(msg).toContain("未绑定");
    // 不得声称成功或返回值。
  });

  it("readSurface 遇到未知 surface 时抛错（绝不静默跳过）", async () => {
    await expect(readSurface("database" as never, ctx)).rejects.toThrow();
  });
});

describe("surface reader——tui_socket `state` 查询（虚假 unix socket）", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("连接、准确发送 `state` 并解析单行 JSON 回复", async () => {
    // 保持 socket 路径简短（sun_path 上限约 104 字节）：tmpdir + 短名称。
    const d = mkdtempSync(join(tmpdir(), "ts-"));
    dirs.push(d);
    const sockPath = join(d, "t.sock");
    const stateReply = { ok: true, instanceId: "i1", state: { ok: true, screen: "rigs", drill: [], viewTab: "graph" } };
    let received = "";
    const server = net.createServer((conn) => {
      conn.on("data", (b) => {
        received += b.toString();
        if (received.includes("\n") || received.trim() === "state") {
          conn.write(JSON.stringify(stateReply) + "\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    try {
      const ctx: SurfaceContext = {
        rigBin: RIG_BIN,
        readEnv: { OPENRIG_TUI_SOCKET: sockPath },
        baseUrl: "http://127.0.0.1:1",
      };
      const observed = await readSurface("tui_socket", ctx);
      expect(observed).toEqual(stateReply);
      expect(received.trim()).toBe("state"); // sent exactly the OBSERVE verb, no mutation
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("surface reader——实时后台服务（集成）", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined; scaffold = undefined;
  });

  it("ps 与 queue reader 从 scenario 本地后台服务返回解析后的裸数组", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    const ctx: SurfaceContext = { rigBin: RIG_BIN, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl };

    const ps = await readSurface("ps", ctx);
    expect(Array.isArray(ps)).toBe(true);
    const queue = await readSurface("queue", ctx);
    expect(Array.isArray(queue)).toBe(true);
  }, 60_000);

  // 守卫发现 1（假绿）：transcript reader 发出 `--tail --json`，但 `--tail <lines>` 需要值，因此
  // Commander 把 "--json" 当作 tail 值（{"tail":"--json"}），JSON mode 从未启用。containsMatch
  // 单元固定项没有跨越 reader/CLI 边界，所以“D11 覆盖 transcript”对 transcript 并不成立。此测试
  // 真正跨越该边界。
  it("transcript reader 在真实 CLI 边界进入 JSON mode（而非人类文本）", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // 使用 reader 自己的 argv 驱动已发布 CLI，再断言效果：stdout 必须可解析为 JSON；人类文本无法解析。
    const argv = transcriptReadArgv("no-such-seat@scn-none");
    expect(argv).toContain("--json");
    const tailIdx = argv.indexOf("--tail");
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(argv[tailIdx + 1]).toMatch(/^\d+$/); // a VALUE, never the next flag

    const r = await runRig(argv, daemon.readEnv, RIG_BIN);
    expect(() => JSON.parse(r.stdout)).not.toThrow();

    // 负对照：旧 argv 结构无法进入 JSON mode，证明判别项确实能区分二者。
    const broken = ["transcript", "no-such-seat@scn-none", "--tail", "--json"];
    const rBroken = await runRig(broken, daemon.readEnv, RIG_BIN);
    let brokenIsJson = true;
    try { JSON.parse(rBroken.stdout); } catch { brokenIsJson = false; }
    expect(brokenIsJson).toBe(false);
  }, 60_000);
});
