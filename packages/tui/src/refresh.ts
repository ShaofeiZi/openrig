/** 用尾部传递合并重叠的刷新请求（Wave-O B3，R2 508e383d）。
 *
 * 旧形状为每个重叠请求返回活动 promise，因此一个 oracle 推送如果到达在
 * 进行中的 hydrate 已读取其快照之后但在其 settle 之前，就直接消失了——
 * 打开的视图保持陈旧（AM-R18 违规）。现在重叠请求将飞行标记为 DIRTY，
 * 运行器在 settle 前每个重叠窗口最多执行一次尾部传递：每个事件窗口都被代表，
 * 工作量有界（N 个重叠请求 = 一次尾部运行），安静刷新恰好执行一次传递，
 * 任务失败既不中断循环也不拒绝调用方（任务本身负责错误处理；
 * 此处的防护是双保险）。 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  let dirty = false;
  const run = async (): Promise<void> => {
    do {
      dirty = false;
      await task(); // rejection 传播给每个等待的调用方；finally 释放防护
    } while (dirty);
  };
  return () => {
    if (active) {
      dirty = true; // 尾部传递将代表此请求
      return active;
    }
    active = run().finally(() => { active = null; });
    return active;
  };
}
