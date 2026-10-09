// B15 —— 根目录调用的封闭性（经评审的形态：test.projects，而非已废弃的工作区文件）。
// 各包自己的 vitest 配置都带 hermetic-env 装配（D12：清理连接环境、按夹具设置
// OPENRIG_HOME、fetch 防护），但从仓库根目录裸跑 `npx vitest run packages/cli/test/x.test.ts`
// 时找不到配置，会在无防护下运行——在某个席位里这意味着套件绕过 mock 直连了实时 daemon，
// 产生 13 个假失败，浪费了一个 QA 周期并派发了一个工单（B15）。本根配置让根目录调用
// 解析到每个包自己的配置，从而把保证真正放在“绕不过去的地方”——在 carrier vitest 上
// 继续读到 v4 之后（工作区文件变体已废弃，升级时会悄悄重新打开这个漏洞）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
