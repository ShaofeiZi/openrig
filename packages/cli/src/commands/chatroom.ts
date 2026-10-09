import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { execSync } from "node:child_process";

interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
}

async function resolveRigId(client: DaemonClient, rigName: string): Promise<string> {
  const res = await client.get<RigSummary[]>("/api/rigs/summary");
  const matches = res.data.filter((r) => r.name === rigName);

  if (matches.length === 0) {
    throw new Error(`未找到工作组 '${rigName}'。列出工作组：zrig ps`);
  }
  if (matches.length > 1) {
    throw new Error(`工作组 '${rigName}' 有歧义——共有 ${matches.length} 个同名工作组。请使用唯一名称或删除重复项。`);
  }

  return matches[0]!.id;
}

export function chatroomCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("chatroom").description("用于工作组内通信的聊天室");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient | null> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // zrig chatroom send <rig> "message" [--sender <name>]
  cmd
    .command("send")
    .argument("<rig>", "工作组名")
    .argument("<message>", "要发送的消息")
    .option("--sender <name>", "（已废弃，忽略）发送者由席位环境变量派生（X-OpenRig-Session）；P21 起聊天路由从传输请求头派生")
    .action(async (rig: string, message: string, _opts: { sender?: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      // P21：请求体不带 sender——后台服务从传输请求头派生（X-OpenRig-Session，
      // 由 DaemonClient 从席位环境变量盖戳）。与请求头不一致的硬编码 'cli' 会
      // 被请求头覆盖（transport:v1），而不是落库（P18：409 不一致已退役）。
      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/send`,
        { body: message },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      // P21：回显派生出来的席位身份（后台服务盖为 X-OpenRig-Session 的环境变量），
      // 而非已废弃的 --sender 标志——让本地确认与聊天路由实际记录的一致。
      console.log(`[${readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME") ?? "你"}] ${message}`);
    });

  // zrig chatroom history <rig> [--topic <name>] [--limit N] [--json]
  cmd
    .command("history")
    .argument("<rig>", "工作组名")
    .option("--topic <name>", "按主题过滤")
    .option("--after <id>", "该消息 ID 之后的消息")
    .option("--since <timestamp>", "该时间戳之后的消息")
    .option("--sender <name>", "该发送者的消息")
    .option("--limit <n>", "限制返回条数", "50")
    .option("--json", "以 JSON 输出")
    .action(async (rig: string, opts: { topic?: string; after?: string; since?: string; sender?: string; limit?: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const params = new URLSearchParams();
      if (opts.topic) params.set("topic", opts.topic);
      if (opts.after) params.set("after", opts.after);
      if (opts.since) params.set("since", opts.since);
      if (opts.sender) params.set("sender", opts.sender);
      if (opts.limit) params.set("limit", opts.limit);

      const qs = params.toString();
      const res = await client.get<Array<Record<string, unknown>>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/history${qs ? `?${qs}` : ""}`,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      const messages = res.data;
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log("暂无消息。");
        return;
      }

      for (const msg of messages) {
        const kind = msg["kind"] as string;
        if (kind === "topic") {
          console.log(`--- 主题：${msg["topic"]} ---`);
        } else {
          console.log(`[${msg["sender"]}] ${msg["body"]}`);
        }
      }
    });

  // zrig chatroom watch <rig> [--tmux]
  cmd
    .command("watch")
    .argument("<rig>", "工作组名")
    .option("--tmux", "在独立 tmux 会话中运行 watch")
    .action(async (rig: string, opts: { tmux?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      if (opts.tmux) {
        const sessionName = `chatroom@${rig}`;
        try {
          execSync(`tmux new-session -d -s ${JSON.stringify(sessionName)} "rig chatroom watch ${JSON.stringify(rig)}"`, { stdio: "ignore" });
          console.log(`已在 tmux 会话中启动 watch：${sessionName}`);
          console.log(`挂载：tmux attach -t ${sessionName}`);
        } catch {
          console.error(`创建 tmux 会话 '${sessionName}' 失败。它可能已存在。`);
          process.exitCode = 1;
        }
        return;
      }

      // 直接 SSE 监听
      const url = `${client.baseUrl}/api/rigs/${encodeURIComponent(rigId)}/chat/watch`;
      try {
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok || !res.body) {
          console.error(`监听失败（HTTP ${res.status}）`);
          process.exitCode = 1;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              try {
                const msg = JSON.parse(data) as { sender: string; body: string; kind: string; topic?: string; createdAt: string };
                if (msg.kind === "topic") {
                  console.log(`--- 主题：${msg.topic} ---`);
                } else {
                  console.log(`[${msg.sender}] ${msg.body}`);
                }
              } catch {
                // 跳过格式错误的 data 行
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(`监听错误：${(err as Error).message}`);
          process.exitCode = 1;
        }
      }
    });

  // zrig chatroom topic <rig> <topic-name> [--body "text"]
  cmd
    .command("topic")
    .argument("<rig>", "工作组名")
    .argument("<topic-name>", "主题名")
    .option("--body <text>", "可选的正文文本")
    .option("--sender <name>", "（已废弃，忽略）发送者由席位环境变量派生（X-OpenRig-Session）；聊天主题路由从传输请求头派生")
    .action(async (rig: string, topicName: string, opts: { body?: string; sender?: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      // P21：请求体不带 sender——后台服务从传输请求头派生（见 chat/send）。
      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/topic`,
        { topic: topicName, body: opts.body },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(`--- 主题：${topicName} ---`);
    });

  // zrig chatroom wait <rig>
  cmd
    .command("wait")
    .argument("<rig>", "工作组名")
    .option("--after <id>", "只看该 ID 之后的消息")
    .option("--topic <name>", "按主题过滤")
    .option("--sender <name>", "按发送者过滤")
    .option("--timeout <seconds>", "超时（秒）", "120")
    .option("--json", "以 JSON 输出")
    .action(async (rig: string, opts: { after?: string; topic?: string; sender?: string; timeout: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const timeoutMs = parseInt(opts.timeout, 10) * 1000;
      const pollIntervalMs = 3000;

      // 起始游标：若提供 --after 则用它，否则在启动时生成一个 ULID
      // 作为实用的时间基线。ID 在该点之后的消息视为新消息。
      let cursor = opts.after ?? "";
      if (!cursor) {
        const { monotonicFactory } = await import("ulid");
        cursor = monotonicFactory()();
      }

      // 构造过滤参数
      const filterParams = new URLSearchParams();
      if (opts.topic) filterParams.set("topic", opts.topic);
      if (opts.sender) filterParams.set("sender", opts.sender);

      const start = Date.now();
      while (true) {
        // 在轮询前先检查超时
        if (Date.now() - start >= timeoutMs) break;

        const params = new URLSearchParams(filterParams);
        if (cursor) params.set("after", cursor);

        const res = await client.get<Array<Record<string, unknown>>>(
          `/api/rigs/${encodeURIComponent(rigId)}/chat/history?${params}`,
        );

        if (res.data && res.data.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(res.data));
          } else {
            for (const msg of res.data) {
              console.log(`[${msg["sender"]}] ${msg["body"]}`);
            }
          }
          return;
        }

        // 睡眠时考虑剩余超时
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
      }

      console.error(`${opts.timeout} 秒超时——没有匹配过滤条件的新消息。`);
      process.exitCode = 1;
    });

  // zrig chatroom clear <rig>
  cmd
    .command("clear")
    .argument("<rig>", "工作组名")
    .action(async (rig: string) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const res = await client.post<{ ok: boolean; deleted: number }>(`/api/rigs/${encodeURIComponent(rigId)}/chat/clear`, {});

      if (res.status >= 400) {
        console.error(`清空失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(`已从 ${rig} 聊天室清空 ${res.data.deleted} 条消息。`);
    });

  return cmd;
}
