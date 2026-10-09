import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // P6/D12 残留：许多后台服务套件会启动真实子进程（stub-runner-*、precompact-hook、
    // bridge、restore-from-jsonl，共 20 多个文件）。在 fold-gate 争用下（并行文件 + 全局负载），
    // 单次 Node 启动可能耗时 5–10 秒，超过 Vitest 默认 5 秒并因 TIMEOUT 偶发失败，而不是断言失败。
    // 较宽裕的上限使这些测试具有确定性；快速测试仍在毫秒级完成，唯一代价是真实挂起稍晚暴露。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
