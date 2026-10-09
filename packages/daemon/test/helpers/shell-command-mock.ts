import { vi } from "vitest";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";

/** 无需在单元测试 fixture 中写入启动脚本，即可观察命令构建器边界。 */
export function mockShellCommand<T extends TmuxAdapter>(tmux: T): T {
  tmux.sendShellCommand = vi.fn(async (target: string, command: string) => {
    const text = await tmux.sendText(target, command);
    if (!text.ok) return text;
    const enter = await tmux.sendKeys(target, ["Enter"]);
    if (!enter.ok) await tmux.sendKeys(target, ["C-c"]);
    return enter;
  });
  return tmux;
}
