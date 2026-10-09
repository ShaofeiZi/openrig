import net from "node:net";
import { accessSync, mkdirSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { ConfigStore, RiggedConfig } from "./config-store.js";
import type { DaemonStatus } from "./daemon-lifecycle.js";
import { buildTmuxControlFailure, probeTmuxControlAsync } from "./tmux-health.js";
import { classifyNodeVersion } from "./node-support.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  error?: string;
  reason?: string;
  fix?: string;
  /** 在通过的检查上设置，携带限定条件（例如未测试的 Node 大版本）。 */
  warning?: string;
}

export interface PreflightResult {
  ready: boolean;
  checks: PreflightCheck[];
}

interface PreflightDeps {
  exec: (cmd: string) => Promise<string>;
  configStore: ConfigStore;
  getDaemonStatus: () => Promise<DaemonStatus>;
  openrigHome?: string;
  riggedHome?: string;
}

interface RunOverrides {
  port?: number;
  host?: string;
}


interface WritableHomeCheckDeps {
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
}

function checkPort(host: string, port: number): Promise<boolean> {
  if (port <= 0) return Promise.resolve(true); // 端口 0 始终可用
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false); // 端口已被占用
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(true); // 端口可用
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(true); // 超时 = 无监听
    });
    socket.connect(port, host);
  });
}

export function buildWritableHomeCheck(
  config: RiggedConfig,
  openrigHome: string,
  deps: WritableHomeCheckDeps = {},
): PreflightCheck {
  const mkdirp = deps.mkdirp ?? ((dirPath: string) => mkdirSync(dirPath, { recursive: true }));
  const checkWritable = deps.checkWritable ?? ((dirPath: string) => accessSync(dirPath, constants.W_OK));

  const pathsToCheck = [
    { path: openrigHome, label: "zrig 主目录" },
  ];
  const dbDir = dirname(config.db.path);
  if (dbDir && dbDir !== openrigHome && !dbDir.startsWith(openrigHome + "/")) {
    pathsToCheck.push({ path: dbDir, label: "数据库目录" });
  }
  const transcriptPath = config.transcripts.path;
  if (transcriptPath && transcriptPath !== openrigHome && !transcriptPath.startsWith(openrigHome + "/")) {
    pathsToCheck.push({ path: transcriptPath, label: "转录目录" });
  }

  const writableErrors: string[] = [];
  for (const { path: dirPath, label } of pathsToCheck) {
    try {
      mkdirp(dirPath);
      checkWritable(dirPath);
    } catch {
      writableErrors.push(`无法写入 ${dirPath}（${label}）。`);
    }
  }

  if (writableErrors.length === 0) {
    return { name: "writable_home", ok: true };
  }

  return {
    name: "writable_home",
    ok: false,
    error: writableErrors.join(" "),
    reason: "zrig 在这些目录中存储数据库、配置和转录。",
    fix: "修复目录权限，或用 zrig config set db.path / transcripts.path 更改路径。",
  };
}

export class SystemPreflight {
  private deps: PreflightDeps;

  constructor(deps: PreflightDeps) {
    this.deps = deps;
  }

  async run(overrides?: RunOverrides): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const config = this.deps.configStore.resolve();
    const effectivePort = overrides?.port ?? config.daemon.port;
    const effectiveHost = overrides?.host ?? config.daemon.host;
    const openrigHome = this.deps.openrigHome ?? this.deps.riggedHome ?? "";

    // 1. Node 版本
    const nodeSupport = classifyNodeVersion(process.version);
    if (nodeSupport.kind === "supported") {
      checks.push({ name: "node_version", ok: true });
    } else if (nodeSupport.kind === "untested") {
      checks.push({ name: "node_version", ok: true, warning: nodeSupport.message });
    } else {
      checks.push({
        name: "node_version",
        ok: false,
        error: nodeSupport.message,
        reason: nodeSupport.reason,
        fix: nodeSupport.fix,
      });
    }

    // 2. tmux 可用性
    const tmuxProbe = await probeTmuxControlAsync(this.deps.exec);
    if (tmuxProbe.code === "not_installed") {
      checks.push({
        name: "tmux",
        ok: false,
        error: "在 PATH 中未找到 tmux。",
        reason: "zrig 使用 tmux 创建和控制智能体会话。",
        fix: "安装 tmux（macOS 上 brew install tmux，Debian/Ubuntu 上 apt install tmux）。",
      });
    } else if (tmuxProbe.available) {
      checks.push({ name: "tmux", ok: true });
    } else {
      const failure = buildTmuxControlFailure(tmuxProbe.detail ?? "未知 tmux 控制失败");
      checks.push({
        name: "tmux",
        ok: false,
        error: failure.message,
        reason: failure.reason,
        fix: failure.fix,
      });
    }

    // 3. 可写的 OpenRig home + 转录路径
    checks.push(buildWritableHomeCheck(config, openrigHome));

    // 4. 后台服务端口可用性
    const status = await this.deps.getDaemonStatus();
    const daemonOnSameEndpoint =
      status.state === "running" &&
      (status.host ?? "127.0.0.1") === effectiveHost &&
      status.port === effectivePort;

    if (daemonOnSameEndpoint) {
      // 我们的后台服务已在此端点上运行——跳过
      checks.push({ name: "port_available", ok: true });
    } else {
      const available = await checkPort(effectiveHost, effectivePort);
      if (available) {
        checks.push({ name: "port_available", ok: true });
      } else {
        checks.push({
          name: "port_available",
          ok: false,
          error: `端口 ${effectivePort} 在 ${effectiveHost} 上已被占用。`,
          reason: "后台服务无法绑定到已被占用的端口。",
          fix: `运行 zrig config set daemon.port ${effectivePort + 1} 并重试，或用 lsof -nP -iTCP:${effectivePort} -sTCP:LISTEN 找到已有进程。`,
        });
      }
    }

    return {
      ready: checks.every((c) => c.ok),
      checks,
    };
  }
}
