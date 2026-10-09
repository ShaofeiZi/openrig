import { describe, it, expect, vi } from "vitest";
import {
  spawnContainerDaemon,
  ContainerDaemonError,
  type DockerResult,
} from "./helpers/scenario-container.js";
import { HermeticEnvError, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { L3_HOST_PORT, BIND_ENV, BIND_VALUE, BEARER_ENV } from "./helpers/testbed-published-daemon.js";

// 51-04 step-3 —— CONTAINER(容器)模式的后台服务适配器。它是 spawnScenarioDaemon 的
// ScenarioDaemon 形态姊妹实现:不在主机上拉起场景本地的后台服务,而是按 MANIFEST 标识
// 用 docker 运行 testbed 镜像,在容器内部启动后台服务,并把主机侧 `rig` 的读取指向已发布端口。
// docker 调用器是 INJECTED(注入)的(对应 runRig 的 `node <rigBin>` 接缝),因此本单测在
// 没有任何真实 docker 的情况下运行 —— 真实 docker 那一路是主机侧的 L6 runbook。
//
// 承重性质:适配器自行把 readEnv.OPENRIG_URL 设为它自己容器的已发布 URL
// (遵循 injectClockNow 先例 —— 绝不指向外部目标),而 fail-closed 守卫仍然会在运行
// 任何 docker 之前拒绝一个被继承的外部目标(容器不是削弱 DAEMON_TARGET 守卫的借口 —— L4)。

const CONTAINER_ID = "c0ffeeb0bacafe0123456789abcdef0123456789abcdef0123456789abcdef01";

/** 注入式 `docker` 调用器的记录型假件。 */
function fakeDocker(program?: (args: string[]) => Partial<DockerResult>) {
  const calls: string[][] = [];
  const docker = vi.fn(async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    const verb = args[0];
    const base: DockerResult = { stdout: "", stderr: "", code: 0 };
    // `docker run -d …` 会把启动的容器 id 打印到 stdout。
    if (verb === "run") base.stdout = `${CONTAINER_ID}\n`;
    return { ...base, ...(program?.(args) ?? {}) };
  });
  return { docker, calls };
}

/** 最小内存脚手架 —— 一个已清洗的 env(无后台服务目标)+ 一个清理 spy。 */
function fakeScaffold(env: Record<string, string | undefined> = {}): HermeticScaffold {
  return {
    root: "/scratch/root",
    home: "/scratch/root/home",
    openrigHome: "/scratch/root/openrig",
    stateDir: "/scratch/root/state",
    env: { HOME: "/scratch/root/home", PATH: "/usr/bin", ...env },
    cleanup: vi.fn(),
  };
}

const IMAGE = "openrig-testbed:deadbeef";

describe("spawnContainerDaemon —— 按标识 docker-run 运行 testbed 镜像", () => {
  it("运行指定镜像,把容器端口发布到主机端口", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 34567,
      containerPort: 7433,
    });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toBeDefined();
    // 分离模式运行,把 127.0.0.1:<hostPort>:<containerPort> 发布出去,针对指定镜像。
    expect(runCall).toContain("-d");
    // 不带限定的发布形式 `P:C` —— 不加 127.0.0.1 前缀(Apple container 1.2.0 在带限定形式下会重置)。
    expect(runCall).toContain("34567:7433");
    expect(runCall).not.toContain("127.0.0.1:34567:7433");
    expect(runCall).toContain(IMAGE);
    // 镜像引用必须出现在 flags 之后(docker 位置参数顺序)。
    expect(runCall!.indexOf(IMAGE)).toBeGreaterThan(runCall!.indexOf("-d"));
    expect(daemon.port).toBe(34567);
    expect(daemon.baseUrl).toBe("http://127.0.0.1:34567");
  });

  it("用显式的 0.0.0.0 绑定以及该绑定所要求的 bearer 启动容器内的后台服务", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 34567, bearerToken: "tok-abc123" });
    const startExec = calls.find((c) => c[0] === "exec" && c.includes("start"))!;
    // -e 环境变量 flag 出现在容器 id 之前(docker exec -e … <id> …)。
    const idIdx = startExec.indexOf(CONTAINER_ID);
    const envPart = startExec.slice(0, idIdx);
    expect(envPart).toContain(`${BIND_ENV}=${BIND_VALUE}`);        // OPENRIG_HOST=0.0.0.0
    expect(envPart).toContain(`${BEARER_ENV}=tok-abc123`);         // OPENRIG_AUTH_BEARER_TOKEN=<token>
    expect(envPart.filter((a) => a === "-e").length).toBe(2);
    // 主机侧的读取携带 TERMINAL token(同一个值),以便它们通过受守卫路由的认证。
    expect(daemon.readEnv.OPENRIG_TERMINAL_BEARER_TOKEN).toBe("tok-abc123");
  });

  it("在已启动的容器内部启动后台服务,并在返回前等待其就绪", async () => {
    const { docker, calls } = fakeDocker();
    await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 34567,
      containerPort: 7433,
    });
    // 后台服务通过 `docker exec <id> rig daemon start …` 启动,id 取自
    // `docker run` —— 复用的是随包发布的同一条 `rig daemon start`,
    // 它会阻塞在自己的 /healthz 上(顺带完成就绪判定),与主机模式一致。
    const startExec = calls.find((c) => c[0] === "exec" && c.includes("start"));
    expect(startExec).toBeDefined();
    expect(startExec).toContain(CONTAINER_ID);
    expect(startExec!.slice(startExec!.indexOf(CONTAINER_ID) + 1)).toEqual([
      "rig",
      "daemon",
      "start",
      "--port",
      "7433",
      "--no-kernel",
    ]);
    // run 先于容器内 start。
    const runIdx = calls.findIndex((c) => c[0] === "run");
    const startIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("start"));
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(runIdx);
  });

  it("自行把 readEnv.OPENRIG_URL 设为它自己容器的已发布 URL(而非外部地址)", async () => {
    const { docker } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold({ RIG_SCRATCH: "keep-me" }), {
      image: IMAGE,
      docker,
      hostPort: 34567,
    });
    // readEnv = { ...scaffold.env, OPENRIG_URL: <其自身的已发布 url> } —— 与
    // scenario-daemon.ts:148 完全相同的形态,因此主机侧 `rig` 的读取命中本容器。
    expect(daemon.readEnv.OPENRIG_URL).toBe("http://127.0.0.1:34567");
    expect(daemon.readEnv.RIG_SCRATCH).toBe("keep-me");
    expect(daemon.readEnv.HOME).toBe("/scratch/root/home");
  });

  it("未指定容器端口时默认为 7433(不带限定的发布形式)", async () => {
    const { docker, calls } = fakeDocker();
    await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 40000 });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toContain("40000:7433");
    expect(runCall).not.toContain("127.0.0.1:40000:7433");
  });

  it("主机端口默认为显式指定的 L3_HOST_PORT(绝不使用临时空闲端口)", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker });
    expect(daemon.port).toBe(L3_HOST_PORT); // 19433,显式且确定
    expect(calls.find((c) => c[0] === "run")).toContain(`${L3_HOST_PORT}:7433`);
  });

  it("拒绝临时主机端口(0)—— publishArg 抛错,因此它无法蒙混过关", async () => {
    const { docker } = fakeDocker();
    await expect(spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 0 })).rejects.toThrow(/explicit positive integer|Ephemeral/);
  });
});

describe("spawnContainerDaemon —— 生命周期映射到 docker 动词", () => {
  it("sigterm 原地停止后台服务(保留容器以便重启)", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 });
    calls.length = 0;
    await daemon.sigterm();
    const stopExec = calls.find((c) => c[0] === "exec" && c.includes("stop"));
    expect(stopExec).toContain(CONTAINER_ID);
    expect(stopExec!.slice(stopExec!.indexOf(CONTAINER_ID) + 1)).toEqual(["rig", "daemon", "stop"]);
    // sigterm 绝不能删除容器(重启必须能够重新拉起)。
    expect(calls.some((c) => c[0] === "rm")).toBe(false);
  });

  it("restart 在同一容器/端口上先停止再重新启动后台服务", async () => {
    const { docker, calls } = fakeDocker();
    const daemon = await spawnContainerDaemon(fakeScaffold(), {
      image: IMAGE,
      docker,
      hostPort: 1,
      containerPort: 7433,
    });
    calls.length = 0;
    await daemon.restart();
    const stopIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("stop"));
    const startIdx = calls.findIndex((c) => c[0] === "exec" && c.includes("start"));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
    // 重新启动针对同一个容器 id 与同一个端口。
    const startExec = calls[startIdx];
    expect(startExec).toContain(CONTAINER_ID);
    expect(startExec).toContain("7433");
  });

  it("stop 删除容器并清理脚手架", async () => {
    const { docker, calls } = fakeDocker();
    const scaffold = fakeScaffold();
    const daemon = await spawnContainerDaemon(scaffold, { image: IMAGE, docker, hostPort: 1 });
    calls.length = 0;
    await daemon.stop();
    const rm = calls.find((c) => c[0] === "rm");
    expect(rm).toContain("-f");
    expect(rm).toContain(CONTAINER_ID);
    expect(scaffold.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("spawnContainerDaemon —— fail-closed(故障即关闭)与大声报错", () => {
  it("在运行任何 docker 之前拒绝被继承的外部后台服务目标", async () => {
    const { docker, calls } = fakeDocker();
    await expect(
      spawnContainerDaemon(fakeScaffold({ OPENRIG_URL: "http://foreign-daemon.invalid:9999" }), {
        image: IMAGE,
        docker,
        hostPort: 1,
      }),
    ).rejects.toBeInstanceOf(HermeticEnvError);
    // 零 docker 流量 —— 守卫在任何容器被创建之前就已运行。
    expect(calls).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });

  it("`docker run` 以非零码退出时大声报错", async () => {
    const { docker } = fakeDocker((args) =>
      args[0] === "run" ? { code: 125, stderr: "no such image" } : {},
    );
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
  });

  it("`docker run` 没有产出容器 id 时大声报错", async () => {
    const { docker } = fakeDocker((args) => (args[0] === "run" ? { stdout: "   \n" } : {}));
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
  });

  it("容器内后台服务启动失败时拆除已创建的容器", async () => {
    const { docker, calls } = fakeDocker((args) =>
      args[0] === "exec" && args.includes("start") ? { code: 1, stderr: "healthz timeout" } : {},
    );
    await expect(
      spawnContainerDaemon(fakeScaffold(), { image: IMAGE, docker, hostPort: 1 }),
    ).rejects.toBeInstanceOf(ContainerDaemonError);
    // 没有泄漏的容器:启动失败的这次会删除它自己创建的那一个。
    const rm = calls.find((c) => c[0] === "rm");
    expect(rm).toContain("-f");
    expect(rm).toContain(CONTAINER_ID);
  });
});
