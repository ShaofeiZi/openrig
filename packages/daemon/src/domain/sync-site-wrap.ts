import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";

let recorder: SlowOperationInstrumentation | undefined;

export function configureSyncSiteRecorder(next: SlowOperationInstrumentation | undefined): void {
  recorder = next;
}

export function runSyncSite<T>(site: string, fn: () => T): T {
  return recorder?.runSync ? recorder.runSync(site, fn) : fn();
}

/**
 * runSyncSite 的异步对应函数：通过 recorder 的异步 `runStage` 接缝检测非阻塞调用点；
 * 未配置 recorder 时回退为直接调用。工作不得阻塞事件循环的调用点应使用此函数，例如通过
 * 异步 execFile 采样进程表。若用同步 `runSyncSite` 包装 `execFileSync`，整个子进程期间
 * 事件循环都会冻结；本函数正是为修复这种 daemon 性能退化而引入。
 */
export async function runAsyncSite<T>(site: string, fn: () => Promise<T>): Promise<T> {
  return recorder?.runStage ? recorder.runStage(site, fn) : fn();
}
