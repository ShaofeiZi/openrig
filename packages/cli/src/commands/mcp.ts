import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { createMcpServer } from "../mcp-server.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `zrig mcp serve` — 启动封装后台服务 API 的 MCP 服务器。
 * @param depsOverride - 便于测试注入的依赖
 * @returns Commander 命令对象
 */
export function mcpCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("mcp").description("用于接入智能体的 MCP 服务器");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("serve")
    .description("启动 MCP 服务器（stdio 传输）")
    .option("--port <port>", "覆盖后台服务端口")
    .action(async (opts: { port?: string }) => {
      const deps = getDepsF();

      let daemonPort: number;
      if (opts.port) {
        daemonPort = parseInt(opts.port, 10);
        if (isNaN(daemonPort)) {
          console.error("端口号无效");
          process.exitCode = 1;
          return;
        }
      } else {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (!daemonStatusGuard(status)) return;
        daemonPort = status.port!;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${daemonPort}`);
      const server = createMcpServer(client);
      const transport = new StdioServerTransport();
      await server.connect(transport);

      // 保持运行直到传输连接关闭
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
      });

      await server.close();
    });

  return cmd;
}
