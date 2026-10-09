import { Command } from "commander";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { execSync } from "node:child_process";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";
import { buildWritableHomeCheck } from "../system-preflight.js";
import {
  CMUX_SETTINGS_DISCLOSURE_PATH,
  isCmuxSocketControlCompatible,
  readCmuxSocketControlModeFromText,
  resolveCmuxSettingsPath,
} from "../cmux-config.js";
import { buildTmuxControlFailure, probeTmuxControl } from "../tmux-health.js";
import { parse as parseYaml } from "yaml";
import { compareSpecToLive, topologyFromRigSpec, topologyFromLiveLogicalIds } from "@openrig/daemon/spec-conformance";
import { classifyNodeVersion } from "../node-support.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export interface DoctorDeps {
  exists: (p: string) => boolean;
  baseDir: string;
  readFile: (path: string) => string | null;
  exec: (cmd: string) => string;
  checkPort: (port: number, host: string) => Promise<boolean>;
  configStore: Pick<ConfigStore, "resolve">;
  platform?: NodeJS.Platform;
  mkdirp?: (path: string) => void;
  checkWritable?: (path: string) => void;
  fetch?: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  /**
   * Build B——与同名运行中工作组对照的工作组规格路径（`--spec`）。
   *
   * 必须显式传入，因为无法自动发现。没有任何地方持久化运行中工作组的规格
   * 路径：`rigs` 表没有 spec/rigRoot 列、`rig_services.rig_root` 为空、
   * `projection_manifest.source_spec` 为空。后台服务不记得是哪个文件描述了
   * 它正在运行的工作组。缺失时本检查以该原因 SKIP，而不是 PASS。
   */
  specPath?: string;
  /** 该规格对应工作组的运行席位 id（`<pod>.<member>`）；无法读取拓扑时为 null。 */
  fetchLiveLogicalIds?: (rigName: string) => Promise<string[] | null>;
}

const DEFAULT_PORT = 7433;

function defaultCheckPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(true); });
    socket.connect(port, host);
  });
}

export function runDoctorChecks(deps: DoctorDeps): { checks: DoctorCheck[]; portCheck: Promise<DoctorCheck>; asyncChecks: Promise<DoctorCheck>[] } {
  const checks: DoctorCheck[] = [];
  const platform = deps.platform ?? process.platform;

  // 1. 后台服务 dist
  const daemonPath = resolveDaemonPath(deps.baseDir, deps.exists);
  const daemonEntry = path.join(daemonPath, "dist/index.js");
  if (deps.exists(daemonEntry)) {
    checks.push({ name: "daemon_dist", status: "pass", message: `已在 ${daemonPath} 找到后台服务 dist` });
  } else {
    checks.push({
      name: "daemon_dist",
      status: "fail",
      message: "未找到后台服务 dist。",
      reason: "启动 zrig 后台服务进程需要编译产物。",
      fix: "在仓库根目录运行 'npm run build:package'，或用 'npm install -g @openrig/cli' 重装。",
    });
  }

  // 2. UI dist
  const uiDistPath = path.resolve(daemonPath, "..", "ui", "dist", "index.html");
  if (deps.exists(uiDistPath)) {
    checks.push({ name: "ui_dist", status: "pass", message: "已找到 UI dist。" });
  } else {
    checks.push({
      name: "ui_dist",
      status: "fail",
      message: "未找到 UI dist。",
      reason: "仪表盘渲染需要预构建的 UI 资源。",
      fix: "在仓库根目录运行 'npm run build:package'，或用 'npm install -g @openrig/cli' 重装。",
    });
  }

  // 3. Node 版本
  const nodeSupport = classifyNodeVersion(process.version);
  if (nodeSupport.kind === "supported") {
    checks.push({ name: "node_version", status: "pass", message: `Node ${process.version}` });
  } else if (nodeSupport.kind === "untested") {
    checks.push({ name: "node_version", status: "warn", message: nodeSupport.message! });
  } else {
    checks.push({
      name: "node_version",
      status: "fail",
      message: nodeSupport.message!,
      reason: nodeSupport.reason,
      fix: nodeSupport.fix,
    });
  }

  // 4. tmux
  const tmuxProbe = probeTmuxControl((cmd) => deps.exec(cmd));
  if (tmuxProbe.code === "not_installed") {
    checks.push({
      name: "tmux",
      status: "fail",
      message: "未找到 tmux。",
      reason: "zrig 用 tmux 管理智能体会话。",
      fix: "安装 tmux：brew install tmux（macOS）、apt install tmux（Linux）。",
    });
  } else if (tmuxProbe.available && tmuxProbe.version) {
    checks.push({ name: "tmux", status: "pass", message: tmuxProbe.version });
    if (platform === "darwin") {
      const mouseMode = readTmuxMouseMode(deps);
      if (mouseMode === "on") {
        checks.push({
          name: "tmux_mouse",
          status: "pass",
          message: "tmux 鼠标模式已启用。",
        });
      } else if (mouseMode === "off") {
        checks.push({
          name: "tmux_mouse",
          status: "warn",
          message: "tmux 鼠标模式似乎已禁用。",
          reason: "在 macOS 上，启用鼠标模式后 tmux 窗格内的滚动和文本选择会顺畅得多。",
          fix: "为当前 tmux 服务器运行 `tmux set -g mouse on`。要长期启用，把 `set -g mouse on` 加到 `~/.tmux.conf`，并用 `tmux source-file ~/.tmux.conf` 重新加载。",
        });
      }
    }
  } else {
    const failure = buildTmuxControlFailure(tmuxProbe.detail ?? "未知 tmux 控制失败");
    checks.push({
      name: "tmux",
      status: "fail",
      message: failure.message,
      reason: failure.reason,
      fix: failure.fix,
    });
  }

  // 5. cmux shell 检查（可选，但 Open CMUX 工作流推荐）
  let shellCmuxPassed = false;
  try {
    deps.exec("cmux capabilities --json");
    shellCmuxPassed = true;
    checks.push({
      name: "cmux_shell",
      status: "pass",
      message: "cmux shell 控制可用。",
    });
  } catch (err) {
    try {
      deps.exec("cmux --help");
      const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;
      const modeHint = socketMode?.error
        ? ` macOS 上的可能原因：${CMUX_SETTINGS_DISCLOSURE_PATH} 不可读（${socketMode.error}）。`
        : socketMode && !isCmuxSocketControlCompatible(socketMode.mode) && socketMode.source === "default"
        ? ` macOS 上的可能原因：cmux 仍在使用默认的 automation.socketControlMode '${socketMode.mode}'。`
        : socketMode && !isCmuxSocketControlCompatible(socketMode.mode)
        ? ` macOS 上的可能原因：${CMUX_SETTINGS_DISCLOSURE_PATH} 中 automation.socketControlMode 为 '${socketMode.mode}'。`
        : "";
      checks.push({
        name: "cmux_shell",
        status: "warn",
        message: "已安装 cmux，但当前不可用控制。",
        reason: "zrig 没有 cmux 也能运行，但在 cmux 控制可用之前，打开 CMUX 操作和 cmux 感知的节点控制都不可用。",
        fix: `打开 cmux 应用，确认已为 zrig 启用控制访问/socket 共享，然后重跑 'zrig doctor'。如果你是替别人跑这个命令，请告诉对方 cmux 是可选的，但打开 CMUX 需要它。不需要 cmux 功能可以忽略此警告。${modeHint}`,
      });
    } catch {
      checks.push({
        name: "cmux_shell",
        status: "warn",
        message: "未找到 cmux。",
        reason: "zrig 没有 cmux 也能运行，但打开 CMUX 操作和 surface 控制不可用。",
        fix: "需要 Open CMUX 支持就安装并启动 cmux。如果你是替别人跑这个命令，请告诉对方 cmux 是可选的，仅 Open CMUX 工作流需要。",
      });
    }
    void err;
  }

  // 6. 可写状态路径（与预检共用）
  const config = deps.configStore.resolve();
  const writableCheck = buildWritableHomeCheck(config, path.dirname(config.db.path), {
    mkdirp: deps.mkdirp,
    checkWritable: deps.checkWritable,
  });
  checks.push({
    name: writableCheck.name,
    status: writableCheck.ok ? "pass" : "fail",
    message: writableCheck.ok ? "已验证状态路径可写。" : writableCheck.error ?? "状态路径不可写。",
    reason: writableCheck.reason,
    fix: writableCheck.fix,
  });

  // 7. 端口可用性（异步）——已经在该端口上跑的后台服务算作 OK。
  // OPR.0.4.7 slice-05 item-4b：只从配置解析一次后台服务 host+port，并
  // 同时用于 checkPort、healthz、cmux URL 和提示文案（配置在非默认
  // host/port 的后台服务绝不能被报成缺失）。默认仍为 127.0.0.1:7433。
  const daemonHost = config.daemon.host ?? "127.0.0.1";
  const daemonPort = config.daemon.port ?? DEFAULT_PORT;
  const daemonBase = `http://${daemonHost}:${daemonPort}`;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const portCheck = deps.checkPort(daemonPort, daemonHost).then(async (available): Promise<DoctorCheck> => {
    if (available) {
      return { name: "port", status: "pass", message: `端口 ${daemonHost}:${daemonPort} 可用。` };
    }
    // 端口被占用——通过 healthz 检查是不是我们的后台服务
    try {
      const res = await fetchFn(`${daemonBase}/healthz`);
      if (res.ok) {
        return { name: "port", status: "pass", message: `端口 ${daemonHost}:${daemonPort} 已被 zrig 后台服务占用。` };
      }
    } catch { /* 不是我们的后台服务 */ }
    return {
      name: "port",
      status: "fail",
      message: `端口 ${daemonHost}:${daemonPort} 已被其他进程占用。`,
      reason: "后台服务需要这个端口来提供 API 和 UI。",
      fix: `停掉占用端口 ${daemonPort} 的进程，或用不同端口启动后台服务：zrig daemon start --port <port>`,
    };
  });

  // 8. 后台服务 cmux 控制（异步，仅在 shell cmux 通过时检查）
  const asyncChecks: Promise<DoctorCheck>[] = [portCheck];
  if (shellCmuxPassed) {
    const daemonCmuxCheck = (async (): Promise<DoctorCheck> => {
      try {
        const healthRes = await fetchFn(`${daemonBase}/healthz`);
        if (!healthRes.ok) {
          return { name: "cmux_daemon", status: "skipped", message: "后台服务 healthz 不正常。跳过后台服务 cmux 检查。" };
        }
      } catch {
        return { name: "cmux_daemon", status: "skipped", message: "无法连接后台服务。跳过后台服务 cmux 检查。" };
      }

      try {
        const cmuxRes = await fetchFn(`${daemonBase}/api/adapters/cmux/status`);
        if (cmuxRes.ok && cmuxRes.json) {
          const data = (await cmuxRes.json()) as { available?: boolean };
          if (data.available) {
            return { name: "cmux_daemon", status: "pass", message: "后台服务 cmux 控制可用。" };
          }
          return buildCmuxDaemonWarning(deps, platform);
        }
      } catch { /* fetch 失败 */ }

      return buildCmuxDaemonWarning(deps, platform);
    })();
    asyncChecks.push(daemonCmuxCheck);
  }

  asyncChecks.push(buildSpecConformanceCheck(deps));

  return { checks, portCheck, asyncChecks };
}

/**
 * Build B——工作组规格是否仍在描述正在运行的工作组？
 *
 * `rig expand` 之后没有任何东西把规格写回，而 bundle 导出是逐字复制规格的，
 * 因此一个工作组可能悄悄长大到超出它自己的描述。这个检查就是把它点出来——
 * 而且在手工调和规格之后，这个检查用来验证写回真的落盘，而不是靠人盯 YAML。
 *
 * 没有输入时 SKIP 而不是 pass。一个找不到检查对象却保持沉默的检查，和一个
 * 看过之后没发现问题的检查，是无法区分的。
 */
async function buildSpecConformanceCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = "spec_live_conformance";
  if (!deps.specPath) {
    return {
      name,
      status: "skipped",
      message: "未提供 --spec；未检查规格与运行拓扑的一致性。",
      reason:
        "运行中工作组的规格路径没有任何地方持久化（rigs 表没有 spec/rigRoot 列），本检查无法自行发现。",
      fix: "zrig doctor --spec <path/to/rig.yaml>",
    };
  }

  const raw = deps.readFile(deps.specPath);
  if (raw === null) {
    return { name, status: "fail", message: `无法读取 ${deps.specPath} 处的工作组规格。` };
  }

  let spec: { name?: unknown; pods?: unknown };
  try {
    spec = parseYaml(raw) as { name?: unknown; pods?: unknown };
  } catch (err) {
    return { name, status: "fail", message: `${deps.specPath} 处的工作组规格不是合法 YAML：${(err as Error).message}` };
  }
  const rigName = typeof spec?.name === "string" ? spec.name : "";
  if (!rigName || !Array.isArray(spec?.pods)) {
    return { name, status: "fail", message: `${deps.specPath} 处的工作组规格未声明 name 或 pods。` };
  }

  const liveIds = deps.fetchLiveLogicalIds ? await deps.fetchLiveLogicalIds(rigName) : null;
  if (liveIds === null) {
    return {
      name,
      status: "skipped",
      message: `无法读取 '${rigName}' 的运行拓扑；一致性未知。`,
      reason: "没有运行数据不能作为一致的证据，所以这里报为未知而不是通过。",
    };
  }

  const result = compareSpecToLive(topologyFromRigSpec(spec as never), topologyFromLiveLogicalIds(liveIds));
  if (result.conforms) {
    return {
      name,
      status: "pass",
      message: `规格与运行中的工作组 '${rigName}' 一致（${result.spec.pods} 个 pod/${result.spec.seats} 个席位）。`,
    };
  }
  return {
    name,
    status: "warn",
    message: `工作组 '${rigName}'：${result.message}`,
    reason: "bundle 导出是逐字复制规格的，因此导出的工作组会比实际运行的小。",
    fix: "把规格与运行拓扑调和一致，然后重跑本检查以验证写回。",
  };
}

function readCmuxSocketControlMode(deps: DoctorDeps) {
  return readCmuxSocketControlModeFromText(deps.readFile(resolveCmuxSettingsPath()));
}

function buildCmuxDaemonWarning(deps: DoctorDeps, platform: NodeJS.Platform): DoctorCheck {
  const socketMode = platform === "darwin" ? readCmuxSocketControlMode(deps) : null;

  if (platform === "darwin" && socketMode?.error) {
    return {
      name: "cmux_daemon",
      status: "warn",
      message: "shell cmux 可用，但后台服务无法控制 cmux。",
      reason: `${CMUX_SETTINGS_DISCLOSURE_PATH} 不可读：${socketMode.error}`,
      fix: `修复 ${CMUX_SETTINGS_DISCLOSURE_PATH} 或删掉它让 cmux 重新生成模板，然后重跑 \`zrig setup\` 或 \`zrig doctor\`。`,
    };
  }

  if (platform === "darwin" && socketMode && !isCmuxSocketControlCompatible(socketMode.mode)) {
    const reason = socketMode.source === "default"
      ? `cmux 仍在使用默认的 automation.socketControlMode '${socketMode.mode}'，后台服务还不能作为外部 cmux 客户端挂载。`
      : `${CMUX_SETTINGS_DISCLOSURE_PATH} 中 automation.socketControlMode 为 '${socketMode.mode}'，后台服务还不能作为外部 cmux 客户端挂载。`;
    return {
      name: "cmux_daemon",
      status: "warn",
      message: "shell cmux 可用，但后台服务无法控制 cmux。",
      reason,
      fix: `运行 \`zrig setup\` 把 ${CMUX_SETTINGS_DISCLOSURE_PATH} 中的 automation.socketControlMode 设为 "automation"，然后用 \`zrig daemon start\` 重启后台服务。`,
    };
  }

  return {
    name: "cmux_daemon",
    status: "warn",
    message: "shell cmux 可用，但后台服务无法控制 cmux。",
    reason: "后台服务继承的终端/会话环境破坏了 cmux 适配器初始化。",
    fix: "setup 之后用 `zrig daemon start` 重启后台服务。如果仍失败，用 `zrig daemon logs` 查看后台服务日志。",
  };
}

function readTmuxMouseMode(deps: DoctorDeps): "on" | "off" | null {
  try {
    const mode = deps.exec("tmux show-options -gqv mouse").trim().toLowerCase();
    if (mode === "on" || mode === "off") return mode;
    return null;
  } catch {
    return null;
  }
}

export function doctorCommand(depsOverride?: DoctorDeps): Command {
  const cmd = new Command("doctor").description("检查 zrig 安装健康状态");

  cmd
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--spec <path>", "与同名运行中工作组对照的工作组规格（规格 vs 运行拓扑）")
    .action(async (opts: { json?: boolean; spec?: string }) => {
      const deps: DoctorDeps = depsOverride ?? {
        exists: existsSync,
        baseDir: import.meta.dirname,
        readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
        exec: (c: string) => execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }),
        checkPort: defaultCheckPort,
        configStore: new ConfigStore(),
        mkdirp: (dirPath: string) => mkdirSync(dirPath, { recursive: true }),
        checkWritable: (dirPath: string) => accessSync(dirPath, constants.W_OK),
        specPath: opts.spec ? path.resolve(opts.spec) : undefined,
        // 读取运行侧任何失败都返回 null。一致性检查把 null 视为"未知"并跳过——
        // 无法连接的后台服务绝不能被读成拓扑匹配。
        fetchLiveLogicalIds: async (rigName: string): Promise<string[] | null> => {
          try {
            const cfg = new ConfigStore().resolve();
            const base = `http://${cfg.daemon.host ?? "127.0.0.1"}:${cfg.daemon.port ?? DEFAULT_PORT}`;
            const rigsRes = await fetch(`${base}/api/rigs`);
            if (!rigsRes.ok) return null;
            const rigs = (await rigsRes.json()) as Array<{ id?: string; name?: string }>;
            const rig = rigs.find((r) => r.name === rigName);
            if (!rig?.id) return null;
            const nodesRes = await fetch(`${base}/api/rigs/${rig.id}/nodes`);
            if (!nodesRes.ok) return null;
            const nodes = (await nodesRes.json()) as Array<{ logicalId?: string | null }>;
            return nodes.map((n) => n.logicalId ?? "");
          } catch {
            return null;
          }
        },
      };

      const { checks, asyncChecks } = runDoctorChecks(deps);
      const resolvedAsync = await Promise.all(asyncChecks);
      const allChecks = [...checks, ...resolvedAsync];
      const healthy = allChecks.every((c) => c.status !== "fail");

      if (opts.json) {
        console.log(JSON.stringify({ healthy, checks: allChecks }, null, 2));
        if (!healthy) process.exitCode = 1;
        return;
      }

      for (const check of allChecks) {
        const icon = check.status === "pass" ? "通过" : check.status === "warn" ? "警告" : check.status === "skipped" ? "跳过" : "失败";
        console.log(`  [${icon}] ${check.name}: ${check.message}`);
        if (check.reason) console.log(`       原因：${check.reason}`);
        if (check.fix) console.log(`       修复：${check.fix}`);
      }

      console.log("");
      console.log(healthy ? "系统检查看起来都正常。" : "部分检查失败。");
      if (!healthy) process.exitCode = 1;
    });

  return cmd;
}
