// Slice-11 slack-connector —— 密钥解析（条目 7 与 10）。
//
// 密钥（Slack 机器人令牌、应用级令牌、传入 webhook URL）在调用时从
// OPENRIG_SLACK_* 环境变量或权限为 0600 的环境文件中解析；绝不存入连接器
// 配置文件、仓库或日志。该策略与后台服务的 bearer_file/activity-hook-token 一致。
// 环境文件位于受信任主机（条目 10 的 secret-host 轴），可以与队列/告警主机不同。
import fs from "node:fs";

export interface SecretFsOps {
  readFileSync(p: string): string;
  statMode(p: string): number | null; // 八进制权限位；文件不存在时为 null。
}

export const nodeSecretFs: SecretFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  statMode: (p) => {
    try {
      return fs.statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  },
};

/** 解析 KEY=VALUE 行并去除引号；忽略空行和 # 注释。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return out;
}

export interface SecretLookupOpts {
  envFile?: string; // 权限为 0600 的环境文件路径（可选）。
  env?: NodeJS.ProcessEnv; // 进程环境变量（默认 process.env）。
  fsops?: SecretFsOps;
}

/** 环境文件可被组内/其他用户读取时给出警告（条目 10 卫生要求）；否则返回 null。 */
export function checkEnvFilePermissions(envFile: string, fsops: SecretFsOps = nodeSecretFs): string | null {
  const mode = fsops.statMode(envFile);
  if (mode === null) return null; // 文件缺失属于另一类“未配置”问题。
  if (mode & 0o077) return `密钥环境文件 ${envFile} 的权限为 ${mode.toString(8)}；应设为 0600（组用户/其他用户不得读取密钥）`;
  return null;
}

/**
 * 按逻辑名称解析密钥。优先级：显式环境变量（OPENRIG_SLACK_<NAME> 或原始名称）
 * → 环境文件中的键。无法解析时返回 null（调用方应如实报告“未配置”，不能伪造）。
 * 绝不记录密钥值。
 */
export function resolveSecret(name: string, opts: SecretLookupOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const fsops = opts.fsops ?? nodeSecretFs;
  // 别名包括原始名称（如 SLACK_WEBHOOK_URL）和带 OPENRIG_ 前缀的形式
  // （OPENRIG_SLACK_WEBHOOK_URL），而不是 OPENRIG_SLACK_<name>；后者会重复
  // SLACK_ 片段，正是 B4 缺陷。
  const envKeys = [name, `OPENRIG_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  for (const k of envKeys) {
    if (env[k]) return env[k]!;
  }
  if (opts.envFile) {
    try {
      const map = parseEnvFile(fsops.readFileSync(opts.envFile));
      if (map[name]) return map[name];
    } catch {
      /* 缺失或不可读时返回 null。 */
    }
  }
  return null;
}
