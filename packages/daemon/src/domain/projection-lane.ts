// 切片 04——/api/ps 与 /api/rigs/summary 共用的进程内协作式 projection lane。
//
// 两条路由的完整同步响应构建（projection + c.json）在这里作为同一个 job 执行。lane 以 FIFO
// 顺序串行处理 job，并在每个 job 前向事件循环让步（原生 setImmediate，与
// queue-retention.ts 使用相同模式）。因此，即使并发请求突增，事件循环每次最多只被一个 job
// 独占，交错执行的工作（如 /healthz）仍能及时响应。它不是 cache、worker 或通用异步框架：
// 不提供取消、配置或持久化，只负责在同步 job 之间协作式让步。
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

class ProjectionLane {
  // FIFO 链。每个 job 都在前一个结束后运行；无论成功或失败都会恢复 `tail`，因此单个抛错
  // 的 job 不会卡死 lane。
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => T): Promise<T> {
    const result = this.tail.then(async () => {
      await yieldToLoop(); // 在同步 job 前让出执行权，使事件循环可以处理其他工作。
      return job();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// 进程内单例，由本模块持有；不改变 wiring/DI，因此路由文件可直接导入，既有的冻结测试 fixture
// wiring 也无需调整。
export const projectionLane = new ProjectionLane();
