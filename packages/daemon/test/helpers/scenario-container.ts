// 51-04 第 3 步——容器模式场景守护进程适配器（计划 §4）。
//
// spawnScenarioDaemon（scenario-daemon.ts）的 ScenarioDaemon 同结构实现：不在主机上
// 启动场景本地守护进程，而是按清单身份用 Docker 运行测试床镜像，在容器内启动发行版
// 守护进程，并让主机侧 `rig` 读写子进程指向容器公布的端口。它返回相同的
// ScenarioDaemon 契约，因此 runScenarioFile 下游（buildRealDeps + runValidatedScenario）
// 无需修改即可绑定——主机模式保持逐字节不变，容器模式是纯增量选择加入。
//
// Docker 调用器通过注入提供（对应容器版 runRig 的 `node <rigBin>` 接缝），使此适配器
// 无需真实 Docker 即可隔离单测；真实 Docker 路径由主机侧 L6 手册负责。它复用主机模式的
// 关键性质：readEnv.OPENRIG_URL 由适配器自行设置为自己公布的容器 URL，绝非外部目标
//（沿用 injectClockNow 先例）；任何 Docker 运行前，失败关闭护栏仍会拒绝继承的外部目标
//（容器不能成为削弱 DAEMON_TARGET 护栏的借口；L4 主张）。

import { randomBytes } from "node:crypto";
import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";
import { type ScenarioDaemon } from "./scenario-daemon.js";
import { makeContainerStageTopology, type StagingDocker } from "./scenario-container-stage.js";
// 唯一的已公布守护进程流程——只导入，绝不重新推导（模块的一致性围栏正是为捕获漂移）：
// 显式绑定 0.0.0.0 并提供该绑定要求的 bearer，使用无限定 `P:C` 发布，且显式指定
// 非临时主机端口。
import {
  CONTAINER_PORT,
  L3_HOST_PORT,
  publishArg,
  publishedDaemonEnvFlags,
} from "./testbed-published-daemon.js";

/** 注入式 Docker 调用携带退出状态的结果（对应 RigResult）。 */
export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 明确的类型化失败——容器无法启动（或无法启动其守护进程）时必须失败，绝不能以
 *  看似场景就绪的半启动容器静默继续。 */
export class ContainerDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerDaemonError";
  }
}

export interface SpawnContainerDaemonOptions {
  /** 要运行的测试床镜像身份（manifest.image，例如 "openrig-testbed:<gitSha>"）。 */
  image: string;
  /** 注入式 Docker 调用器——对应容器版 runRig 的 `node <rigBin>` 接缝。扩展为携带步骤的
   *  stdin（拓扑暂存 tar 管道）；双退出契约参见 StagingDocker。 */
  docker: StagingDocker;
  /** 容器内的守护进程端口（默认 CONTAINER_PORT = 7433）。 */
  containerPort?: number;
  /** 覆盖公布的主机端口。默认为 L3_HOST_PORT（19433）——显式且非临时；
   *  `publishArg` 遇到 0 时抛错（Apple container 1.2.0 拒绝临时端口发布）。 */
  hostPort?: number;
  /** 绑定 0.0.0.0 所需的 bearer（assertBindAuthInvariant）。默认为新的随机令牌。
   *  同时设置到守护进程（OPENRIG_AUTH_BEARER_TOKEN）并携带在 readEnv 中，使主机侧
   *  `rig` 读取能通过受保护路由的认证。 */
  bearerToken?: string;
}

/**
 * 使用 Docker 运行测试床镜像，并在容器内启动其守护进程，返回 ScenarioDaemon 契约。
 * 如果框架环境仍携带外部守护进程目标、容器无法运行，或容器内守护进程无法启动，
 * 则失败关闭（抛错；拆除已创建容器，避免泄漏）。
 */
export async function spawnContainerDaemon(
  scaffold: HermeticScaffold,
  opts: SpawnContainerDaemonOptions,
): Promise<ScenarioDaemon> {
  // 容器不能成为削弱护栏的借口——创建任何容器前拒绝继承的外部目标
  //（对应 spawnScenarioDaemon:118）。
  assertNoForeignDaemon(scaffold.env);

  const { image, docker } = opts;
  const containerPort = opts.containerPort ?? CONTAINER_PORT;
  const hostPort = opts.hostPort ?? L3_HOST_PORT;
  const bearerToken = opts.bearerToken ?? randomBytes(16).toString("hex");
  // 使用无限定 `P:C`——Apple container 1.2.0 在 `127.0.0.1:P:C` 形式下会重置连接
  //（并拒绝临时端口 0）。publishArg 对非正端口抛错，因此临时分配无法重新混入。
  const publish = publishArg(hostPort, containerPort);

  // 启动长生命周期容器（入口点植入自托管 ID 后执行 CMD）；`tail -f /dev/null` 保持
  // PID 1 存活，以便通过 exec 启动并探测守护进程。
  const run = await docker(["run", "-d", "-p", publish, image, "tail", "-f", "/dev/null"]);
  if (run.code !== 0) {
    throw new ContainerDaemonError(
      `镜像 '${image}' 的 docker run 失败（退出码 ${run.code}）：${run.stderr || run.stdout}`,
    );
  }
  const containerId = run.stdout.trim();
  if (containerId.length === 0) {
    throw new ContainerDaemonError(`镜像 '${image}' 的 docker run 未产生容器 ID`);
  }

  // 唯一的容器内启动路径——初次创建和重启均复用，因此重启会通过完全相同的发行版
  // `zrig daemon start` 再次创建（兼容性测试仍调用旧入口 `rig`；该命令会等待自身
  // /healthz；退出码 0 表示守护进程
  // 正在接受请求）。
  const startProc = async () => {
    const start = await docker([
      "exec",
      // 显式绑定（OPENRIG_HOST=0.0.0.0）并提供绑定要求的 bearer——默认绑定
      // 127.0.0.1 时无法访问公布端口，而且守护进程会拒绝没有 bearer 的非环回绑定
      //（assertBindAuthInvariant）。满足护栏，绝不削弱它。
      ...publishedDaemonEnvFlags(bearerToken),
      containerId,
      "rig",
      "daemon",
      "start",
      "--port",
      String(containerPort),
      "--no-kernel",
    ]);
    if (start.code !== 0) {
      throw new ContainerDaemonError(
        `容器 ${containerId} 内的守护进程启动失败（退出码 ${start.code}）：${start.stderr || start.stdout}`,
      );
    }
  };
  // 停止容器内守护进程，但保留容器（重启会再次创建进程）。尽力而为。
  const killProc = async () => {
    await docker(["exec", containerId, "rig", "daemon", "stop"]).catch(() => {});
  };

  try {
    await startProc();
  } catch (err) {
    // 若守护进程未能启动，不得泄漏已创建的容器。
    await docker(["rm", "-f", containerId]).catch(() => {});
    throw err;
  }

  const baseUrl = `http://127.0.0.1:${hostPort}`;
  // readEnv = { ...scaffold.env, OPENRIG_URL: <自身公布的 URL> }——与
  // scenario-daemon.ts:148 的结构完全相同；此 URL 由创建容器的适配器自行生成
  //（不是外部目标），因此主机侧 `rig` 读取命中此容器。
  const readEnv: Record<string, string | undefined> = {
    ...scaffold.env,
    OPENRIG_URL: baseUrl,
    // 受保护的探测路由（/api/transport/*）检查 TERMINAL 令牌；主机侧 `rig` 读取通过
    // OPENRIG_TERMINAL_BEARER_TOKEN 发送它（client.ts resolveTerminalToken）。在不受信任的
    // 0.0.0.0 绑定上，守护进程对两者使用同一令牌（index.ts:160），因此此处传入该令牌。
    OPENRIG_TERMINAL_BEARER_TOKEN: bearerToken,
  };

  return {
    port: hostPort,
    baseUrl,
    readEnv,
    sigterm: killProc,
    restart: async () => {
      await killProc();
      await startProc();
    },
    stop: async () => {
      await docker(["rm", "-f", containerId]).catch(() => {});
      scaffold.cleanup();
    },
    // L6 第 0 步——容器模式路径转换：将拓扑目录暂存进容器并返回其容器内路径，使
    // `zrig up` 永远不会收到容器守护进程无法读取的主机绝对路径。buildRealDeps/流水线
    // 在 `up` 前使用它；主机模式省略此步骤。
    stageTopology: makeContainerStageTopology(containerId, docker),
  };
}
