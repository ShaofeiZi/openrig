export interface SetupPromptInput {
  name: string;
  summary?: string;
  sourcePath: string;
}

export function buildSetupPrompt(input: SetupPromptInput): string {
  const lines: string[] = [
    `使用 zrig 安装并启动托管应用 "${input.name}"。`,
    "",
  ];

  if (input.summary) {
    lines.push(`关于：${input.summary}`, "");
  }

  lines.push(
    `来源：${input.sourcePath}`,
    "",
    "步骤：",
    `1. 运行：zrig up ${input.name}`,
    `2. 监控：zrig ps --nodes --rig ${input.name}`,
    `3. 检查环境：zrig env status <rig-name>`,
  );

  return lines.join("\n");
}
