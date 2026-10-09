import type { CrossHostResult } from "./cross-host-executor.js";

/**
 * 为以 `--host` 作为门槛的命令提供共用的 CLI 侧辅助。
 * 集中处理结构化失败格式 + JSON 信封，使 `send.ts` 与 `capture.ts`
 * （以及未来任何 v1 跨主机命令）的输出格式保持一致。
 */

/**
 * OPR.0.4.6.MH4 —— http 传输分支的结构化失败面。
 * 每个分支各自命名自己的步骤分类：http 分支暴露
 * `runRemoteHttpOp` 的步骤（registry/unknown-host/permission-gate/
 * remote-daemon-unreachable/remote-command-failed），带上主机名，
 * 并把远程路由自身的错误文本作为 detail——绝不笼统地写“failed”，
 * 也绝不凭空捏造本地消息。
 */
export function emitRemoteHttpFailure(
  hostId: string,
  target: string,
  result: { failedStep: string; error?: string; data?: unknown },
  json?: boolean,
  hint?: string,
): void {
  const remoteError = (result.data as { error?: string } | undefined)?.error;
  const detail = [result.error, remoteError].filter(Boolean).join(" — ");
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      cross_host: { host: hostId, target, transport: "http" },
      failedStep: result.failedStep,
      error: detail,
      ...(hint ? { hint } : {}),
    }));
  } else {
    console.error(`跨主机（host=${hostId}，${target}）：http ${result.failedStep}：${detail}`);
    if (hint) console.error(`提示：${hint}`);
  }
  process.exitCode = 1;
}

export function emitCrossHostError(hostId: string, code: string, message: string, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, cross_host: { host: hostId }, failedStep: code, error: message }));
  } else {
    console.error(`跨主机（host=${hostId}）：${message}`);
  }
  process.exitCode = 1;
}

export function emitCrossHostFailure(
  hostId: string,
  target: string,
  result: CrossHostResult,
  json?: boolean,
): void {
  if (result.ok) return;
  const message = formatCrossHostFailure(hostId, target, result);
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      cross_host: { host: hostId, target },
      failedStep: result.failedStep,
      error: message,
      ...(result.failedStep === "permission-gate" && result.hint ? { hint: result.hint } : {}),
    }));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}

export function formatCrossHostFailure(
  hostId: string,
  target: string,
  result: Extract<CrossHostResult, { ok: false }>,
): string {
  switch (result.failedStep) {
    case "ssh-unreachable":
      return `到主机 host=${hostId}（target=${target}）的 ssh 连接失败：${oneLine(result.sshStderr)}。请检查 SSH 访问与主机注册表配置。`;
    case "permission-gate":
      return `到主机 host=${hostId}（target=${target}）的 ssh 遇到权限/认证门槛：${oneLine(result.sshStderr)}。${result.hint ?? ""}`.trim();
    case "remote-daemon-unreachable":
      return `主机 host=${hostId} 上的远程 zrig 命令连不到远程后台服务（exit=${result.remoteExitCode}）：${oneLine(result.stderr || result.stdout)}。请在远程用 'ssh ${target} zrig daemon start' 启动后台服务。`;
    case "remote-command-not-found":
    case "remote-command-failed":
      return `主机 host=${hostId} 上的远程 zrig 命令失败（exit=${result.remoteExitCode}）：${oneLine(result.stderr || result.stdout)}`;
  }
}

function oneLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).join(" | ").slice(0, 400);
}
