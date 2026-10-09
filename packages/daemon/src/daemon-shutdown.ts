import { writeFileSync, renameSync } from "node:fs";

export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DAEMON_STOP_WAIT_MS = DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000;
export const DAEMON_SHUTDOWN_RECEIPT = "daemon-shutdown.json";
export interface DaemonShutdownReceipt {
  schema: "openrig.daemon-shutdown/v1";
  pid: number;
  startedAt: string;
  completedAt: string;
  outcome: "clean" | "failed" | "timed-out";
  phase: string;
  failures: Array<{ phase: string; error: string }>;
}

/** 为现有串行清理设置统一预算，包括第一次 await。ponytail：这里只限制异步关闭；同步事件循环
 * 卡死仍需要经过身份检查的操作员恢复，而不是另一个 supervisor。 */
export function createDaemonShutdown(options: {
  phases: Array<[string, () => unknown]>;
  markClean: () => void;
  receiptPath: string;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): (signal: string) => void {
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    let finished = false;
    let phase = "starting";
    const startedAt = new Date().toISOString();
    const failures: DaemonShutdownReceipt["failures"] = [];
    const timeoutMs = options.timeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    const log = options.log ?? console.error;
    const exit = options.exit ?? ((code) => process.exit(code));
    const fail = (error: unknown) => {
      failures.push({ phase, error: String(error) });
      log(`[shutdown] ${phase} 失败：${String(error)}`);
    };
    const finish = (outcome: DaemonShutdownReceipt["outcome"]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let code = outcome === "clean" ? 0 : 1;
      const receipt: DaemonShutdownReceipt = {
        schema: "openrig.daemon-shutdown/v1", pid: process.pid, startedAt,
        completedAt: new Date().toISOString(), outcome,
        phase: outcome === "clean" ? "complete" : phase, failures,
      };
      try {
        const temp = `${options.receiptPath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(receipt) + "\n");
        renameSync(temp, options.receiptPath);
      } catch (error) {
        log(`[shutdown] 无法写入结果回执：${String(error)}`);
        code = 1;
      }
      log(`[shutdown] ${outcome}；phase=${receipt.phase}；预算=${timeoutMs}ms；退出码=${code}`);
      exit(code);
    };
    // 有意保持引用：即使没有 server，也必须执行此时间上限。
    const timer = setTimeout(() => {
      fail(`完整关闭预算已耗尽（${timeoutMs}ms）；待处理效果尚未验证`);
      finish("timed-out");
    }, timeoutMs);
    log(`zrig 后台服务收到 ${signal}；正在关闭（预算 ${timeoutMs}ms）`);
    void (async () => {
      for (const [name, run] of options.phases) {
        if (finished) return;
        phase = name;
        try { await run(); } catch (error) { if (!finished) fail(error); }
      }
      if (finished) return;
      if (failures.length === 0) {
        phase = "lifecycle-stop";
        try { options.markClean(); } catch (error) { fail(error); }
      }
      if (failures.length) phase = failures[0]!.phase;
      finish(failures.length ? "failed" : "clean");
    })();
  };
}
