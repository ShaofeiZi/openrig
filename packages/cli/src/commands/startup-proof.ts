import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

export interface StartupProofDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
}

export interface StartupProofSubmitResult {
  ok: true;
  oriented: "verified";
  nodeId: string;
  challengeId: string;
}

interface Endpoint {
  baseUrl: string;
  token: string;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function resolveStartupProofEndpoint(deps: StartupProofDeps = {}): Endpoint | null {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const home = first(env["OPENRIG_HOME"], env["RIGGED_HOME"]) ?? path.join(os.homedir(), ".openrig");
  let baseUrl = first(env["OPENRIG_URL"], env["RIGGED_URL"]);
  let token = first(env["OPENRIG_ACTIVITY_HOOK_TOKEN"], env["RIGGED_ACTIVITY_HOOK_TOKEN"]);

  if (!baseUrl || !token) {
    try {
      const endpoint = JSON.parse(readFile(path.join(home, "activity-endpoint.json"))) as Record<string, unknown>;
      baseUrl ??= first(endpoint["baseUrl"]);
      token ??= first(endpoint["token"]);
    } catch {
      // 文件查找是尽力而为；环境变量与 host/port 兜底仍可能生效。
    }
  }

  if (!baseUrl) {
    const port = first(env["OPENRIG_PORT"], env["RIGGED_PORT"]);
    if (port) baseUrl = `http://${first(env["OPENRIG_HOST"], env["RIGGED_HOST"]) ?? "127.0.0.1"}:${port}`;
  }

  return baseUrl && token ? { baseUrl, token } : null;
}

export async function submitStartupProof(
  input: { challengeId: string; answer: string },
  deps: StartupProofDeps = {},
): Promise<StartupProofSubmitResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = resolveStartupProofEndpoint(deps);
  if (!endpoint) {
    throw new Error("zrig 启动校验端点不可用");
  }

  const res = await fetchImpl(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify({
      eventFamily: "startup_proof",
      sessionName: first(env["OPENRIG_SESSION_NAME"], env["RIGGED_SESSION_NAME"]),
      nodeId: first(env["OPENRIG_NODE_ID"], env["RIGGED_NODE_ID"]),
      runtime: first(env["OPENRIG_RUNTIME"], env["RIGGED_RUNTIME"]),
      challengeId: input.challengeId,
      answer: input.answer,
    }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!res.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : text;
    throw new Error(`startup_proof 被拒绝：${res.status} ${message}`);
  }
  return parsed as StartupProofSubmitResult;
}

export function startupProofCommand(depsOverride?: StartupProofDeps): Command {
  const cmd = new Command("startup-proof")
    .description("提交并查看启动定位校验证明");

  cmd.command("submit")
    .description("通过已认证的 zrig 活动钩子提交本席位的启动证明")
    .requiredOption("--challenge-id <id>", "启动提示中的启动挑战 id")
    .requiredOption("--answer <answer>", "启动提示要求的答案")
    .option("--json", "打印原始 JSON 响应")
    .action(async (opts: { challengeId: string; answer: string; json?: boolean }) => {
      try {
        const result = await submitStartupProof({ challengeId: opts.challengeId, answer: opts.answer }, depsOverride);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`启动证明：${result.oriented}`);
          console.log(`节点 ID：${result.nodeId}`);
          console.log(`挑战 ID：${result.challengeId}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  return cmd;
}
