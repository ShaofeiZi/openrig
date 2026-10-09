import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  prepareHermeticEnv,
  HermeticEnvError,
  DAEMON_TARGET_ENV_VARS,
  type HermeticScaffold,
} from "./helpers/hermetic-env.js";

// Slice 51-02——建立在 fail-closed 守卫上的密闭 scaffold 层。prepareHermeticEnv() 为每次运行
// 构建 scratch HOME/OPENRIG_HOME scaffold 和干净的子进程 env（清除后台服务目标变量并设置 scratch
// 路径），而不修改 runner 进程自身环境。它会先关闭失败（外部后台服务目标在创建任何 scaffold 前中止）。
describe("prepareHermeticEnv scaffold", () => {
  const scaffolds: HermeticScaffold[] = [];
  afterEach(() => {
    for (const s of scaffolds.splice(0)) s.cleanup();
  });
  const make = (baseEnv?: Record<string, string | undefined>) => {
    const s = prepareHermeticEnv({ baseEnv });
    scaffolds.push(s);
    return s;
  };

  it("存在外部后台服务目标时，在创建任何 scaffold 前关闭失败", () => {
    let thrown: unknown;
    try {
      prepareHermeticEnv({ baseEnv: { OPENRIG_URL: "http://foreign:9999", HOME: "/real" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HermeticEnvError);
    expect((thrown as Error).message).toContain("OPENRIG_URL");
  });

  it("创建隔离 scratch scaffold（root、home、openrigHome、stateDir 都位于 root 下）", () => {
    const s = make({ HOME: "/real-home", PATH: "/usr/bin" });
    expect(existsSync(s.root)).toBe(true);
    for (const dir of [s.home, s.openrigHome, s.stateDir]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(dir.startsWith(s.root)).toBe(true);
    }
  });

  it("返回干净子进程 env：清除后台服务目标变量并设置 scratch 路径", () => {
    const base = {
      HOME: "/real-home",
      PATH: "/usr/bin",
      OPENRIG_URL: undefined, // 缺失即可。
      OPENRIG_AUTH_BEARER_TOKEN: "secret",
    };
    const s = make(base);
    for (const v of DAEMON_TARGET_ENV_VARS) {
      expect(s.env[v]).toBeUndefined();
    }
    // 凭据也被清除。
    expect(s.env.OPENRIG_AUTH_BEARER_TOKEN).toBeUndefined();
    // scratch 路径指向 scaffold 内部。
    expect(s.env.HOME).toBe(s.home);
    expect(s.env.OPENRIG_HOME).toBe(s.openrigHome);
    expect(s.env.OPENRIG_NO_KERNEL).toBe("1");
    // 私有 tmux wrapper 优先参与命令解析；调用方 PATH 保留在其后，使每个非 tmux 可执行文件仍按原样解析。
    expect(s.env.PATH).toBe(`${join(s.root, "bin")}${delimiter}/usr/bin`);
  });

  it("不修改调用方 env 对象或 process.env", () => {
    const base: Record<string, string | undefined> = { HOME: "/real-home", PATH: "/usr/bin" };
    const beforeHome = process.env.HOME;
    // 提前捕获——不变量是“process.env 不变”，而非某个绝对值。简单的 `not.toBe("1")` 对 env 敏感：
    // 当环境席位已带 OPENRIG_NO_KERNEL="1" 时会误报失败（scaffold 通过 {...baseEnv} 复制 baseEnv，
    // 从不触碰 process.env；旧断言假定环境干净，而此 scaffold 正是为消除该环境敏感性而存在）。
    const beforeNoKernel = process.env.OPENRIG_NO_KERNEL;
    const s = make(base);
    // 调用方 base 对象未改动。
    expect(base.HOME).toBe("/real-home");
    expect(base.OPENRIG_HOME).toBeUndefined();
    // process.env 未改动（与自身此前值比较，因此不受环境影响）。
    expect(process.env.HOME).toBe(beforeHome);
    expect(process.env.OPENRIG_NO_KERNEL).toBe(beforeNoKernel);
    // scaffold 的 env 是独立对象。
    expect(s.env).not.toBe(base);
  });

  it("cleanup 移除 scaffold root", () => {
    const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home" } });
    const root = s.root;
    expect(existsSync(root)).toBe(true);
    s.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("scratch 子进程 env 自身保持密闭（没有外部目标残留）", () => {
    // 干净 env 必须通过自身 fail-closed 守卫，以证明清理完整。
    const s = make({ OPENRIG_HOST: undefined, HOME: "/real", RIGGED_URL: undefined });
    expect(() => {
      // 对生成的 env 重新运行守卫。
      for (const v of DAEMON_TARGET_ENV_VARS) {
        if (s.env[v]) throw new Error(`泄漏了 ${v}`);
      }
    }).not.toThrow();
  });
});
