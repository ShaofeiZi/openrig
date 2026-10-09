import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // P11 base-health（createProgram 装配抖动）：少数测试通过 createProgram() 构建完整命令树，
    // 并驱动其走完 parseAsync——在 tsx 下确实要 ~2 秒（“同时挂载两条命令”的装配测试每次
    // parse 都会重建程序，因为 Commander 会消费 parseAsync）。整套负载下这曾把默认 5000ms
    // 打穿 -> 非确定性超时被误读为回归。按 daemon 的先例（P6-2，20000）给真实工作量测试
    // 诚实的余量；配套修复在装配文件里静态 import src/index.js，使按需编译不再落在
    // 单测超时窗口内。两者都不掩盖产品缺陷（耗时的是 tsx 开发态编译 + 建树，不是发货 CLI 的延迟）。
    testTimeout: 20000,
    hookTimeout: 20000,
    // D12 base-health：每个测试模块前清理该席位的实时 daemon 连接环境，
    // 使整套折叠闸门保持封闭（见 test/hermetic-env.setup.ts）；生产环境行为不受影响。
    setupFiles: ["./test/hermetic-env.setup.ts"],
  },
});
