import { describe, expect, it } from "vitest";
import { buildSetupPrompt } from "../src/lib/build-setup-prompt.js";

describe("buildSetupPrompt", () => {
  it("生成可执行的中文 zrig 安装提示词，并保留来源路径与参数", () => {
    const prompt = buildSetupPrompt({
      name: "acme-build",
      summary: "带专用构建席位与健康检查的示例托管应用",
      sourcePath: "/specs/rigs/build.yaml",
    });

    expect(prompt).toContain('使用 zrig 安装并启动托管应用 "acme-build"。');
    expect(prompt).toContain("关于：带专用构建席位与健康检查的示例托管应用");
    expect(prompt).toContain("来源：/specs/rigs/build.yaml");
    expect(prompt).toContain("zrig up acme-build");
    expect(prompt).toContain("zrig ps --nodes --rig acme-build");
    expect(prompt).toContain("zrig env status <rig-name>");
    expect(prompt).not.toMatch(/(^|\s)rig up /);
  });
});
