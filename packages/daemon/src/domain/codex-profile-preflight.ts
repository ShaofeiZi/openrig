// OPR.0.3.4.7——Codex profile-v2 预检：使用 Codex 自身的加载器证明 profile 可加载。
// 只要 profile 文件存在却无法加载（例如仍含旧版 [profiles.<name>] 表），就必须失败，
// 不能只检查文件是否缺失。rigspec-preflight（每个 Codex 节点启动前）与
// codex-runtime-adapter（已存储 Codex 节点恢复/启动前）共享此检查。

export interface CodexProfileProbeResult {
  ok: boolean;
  profile: string;
  error?: string;
  migrationHint?: string;
}

const PROFILE_PROBE_TIMEOUT_MS = 10_000;

export async function verifyCodexProfileLoads(
  profile: string,
  exec: (cmd: string) => Promise<string>,
  timeoutMs: number = PROFILE_PROBE_TIMEOUT_MS,
): Promise<CodexProfileProbeResult> {
  const cmd = `codex -p ${shellQuote(profile)} mcp list`;
  try {
    await Promise.race([
      exec(cmd),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Codex profile 探测在 ${timeoutMs}ms 后超时`)), timeoutMs),
      ),
    ]);
    return { ok: true, profile };
  } catch (err) {
    const stderrField = (err as { stderr?: string | Buffer })?.stderr;
    const stderr = stderrField
      ? (typeof stderrField === "string" ? stderrField : stderrField.toString()).trim()
      : (err instanceof Error ? err.message : String(err));
    const isLegacyTable = /legacy.*profiles?\./i.test(stderr) ||
      /cannot be used while.*contains legacy/i.test(stderr) ||
      /\[profiles\./i.test(stderr) ||
      /legacy profile selector/i.test(stderr);
    const stderrLines = stderr.split("\n").filter((l) => l.trim());
    const reason = stderrLines.slice(0, 3).join("; ");
    const migrationHint = isLegacyTable
      ? `请将 profile 设置移入 ~/.codex/${profile}.config.toml，并从 config.toml 删除旧版 [profiles.${profile}] 表/选择器。`
      : `请检查 ~/.codex/${profile}.config.toml 是否为有效 TOML（文件缺失也可以，Codex 会应用默认层）。可手动运行 'codex -p ${profile} mcp list' 诊断。`;
    return {
      ok: false,
      profile,
      error: `Codex profile '${profile}' 加载失败：${reason}`,
      migrationHint,
    };
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
