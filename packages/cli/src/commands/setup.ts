import { Command } from "commander";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { runDoctorChecks, type DoctorDeps } from "./doctor.js";
import { resolveDaemonPath } from "../daemon-lifecycle.js";
import { ConfigStore } from "../config-store.js";
import {
  CMUX_SETTINGS_DISCLOSURE_PATH,
  isCmuxSocketControlCompatible,
  readCmuxSocketControlModeFromText,
  resolveCmuxSettingsPath,
  upsertCmuxSocketControlMode,
} from "../cmux-config.js";
import { buildTmuxControlFailure, probeTmuxControl } from "../tmux-health.js";

export interface SetupStep {
  id: string;
  status: "pass" | "applied" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fixHint?: string;
}

export interface VerificationCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export interface RuntimeConfigDisclosure {
  scope: "global" | "project";
  runtime: "claude-code" | "codex" | "cmux";
  path: string;
  purpose: string;
}

export interface SetupResult {
  profile: "core" | "full";
  platform: string;
  ready: boolean;
  steps: SetupStep[];
  runtimeConfig: RuntimeConfigDisclosure[];
  verification?: {
    checks: VerificationCheck[];
  };
}

export interface SetupDeps {
  exec: (cmd: string, opts?: { timeoutMs?: number }) => string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  mkdirp?: (path: string) => void;
  platform?: NodeJS.Platform;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_COMMAND_TIMEOUT_MS = 5 * 60_000;
const CMUX_READY_ATTEMPTS = 5;
const CMUX_READY_DELAY_MS = 1_000;

const CORE_STEP_IDS = [
  "brew",
  "tmux_install",
  "cmux_install",
  "claude_install",
  "claude_auth",
  "codex_install",
  "codex_auth",
  "tmux_config",
  "verify",
];
const FULL_EXTRA_STEP_IDS = ["jq_install", "gh_install"];
const BASE_RUNTIME_CONFIG_DISCLOSURE: RuntimeConfigDisclosure[] = [
  // OPR.0.4.8.2 无关化剥离：OpenRig 不再写 ~/.claude/settings.json——全局
  // 权限允许列表（C2）已移除，所以那个全局文件完全不再触碰。
  {
    scope: "global",
    runtime: "claude-code",
    path: "~/.claude.json",
    purpose: "预信任受管工作区，并标记 Claude onboarding 完成。",
  },
  {
    scope: "project",
    runtime: "claude-code",
    path: ".claude/settings.local.json",
    purpose:
      "应用 context-collector statusLine 配置与 acceptEdits 底线片段。zrig 不烘焙任何 allow/ask/deny 权限策略——harness 原生权限才是控制面。",
  },
  {
    scope: "project",
    runtime: "claude-code",
    path: ".mcp.json",
    purpose: "应用选定的 Claude MCP 运行时资源片段。",
  },
  {
    scope: "global",
    runtime: "codex",
    path: "~/.codex/config.toml",
    purpose: "预信任受管工作区，并应用选定的 Codex 配置运行时资源片段。",
  },
];

const DARWIN_RUNTIME_CONFIG_DISCLOSURE: RuntimeConfigDisclosure = {
  scope: "global",
  runtime: "cmux",
  path: CMUX_SETTINGS_DISCLOSURE_PATH,
  purpose: "把 cmux socket 控制设为 zrig 兼容的自动化模式。",
};

export function defaultDeps(): SetupDeps {
  return {
    exec: (cmd: string, opts?: { timeoutMs?: number }) =>
      execSync(cmd, {
        encoding: "utf-8",
        timeout: opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    readFile: (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p: string, c: string) => writeFileSync(p, c, "utf-8"),
    exists: (p: string) => existsSync(p),
    mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
  };
}

function installCommand(deps: SetupDeps, cmd: string): string {
  return deps.exec(cmd, { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCmuxCapabilities(deps: SetupDeps, attempts = CMUX_READY_ATTEMPTS): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      deps.exec("cmux capabilities --json");
      return true;
    } catch {
      if (index < attempts - 1) {
        await sleep(CMUX_READY_DELAY_MS);
      }
    }
  }
  return false;
}

async function tryEnableCmuxControl(deps: SetupDeps, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "darwin") return false;

  const settingsPath = resolveCmuxSettingsPath();
  const settingsText = deps.readFile(settingsPath);
  const currentMode = readCmuxSocketControlModeFromText(settingsText);
  if (currentMode.error) {
    return false;
  }

  try {
    deps.mkdirp?.(path.dirname(settingsPath));
    const next = upsertCmuxSocketControlMode(settingsText, "automation");
    if (next.changed) {
      deps.writeFile(settingsPath, next.content);
    }
  } catch {
    return false;
  }

  const shellReady = await waitForCmuxCapabilities(deps, 1);
  if (shellReady) {
    try {
      deps.exec("cmux reload-config");
    } catch {
      // 尽力而为：reload 失败时，后台服务侧校验会如实暴露。
    }
    return waitForCmuxCapabilities(deps, 1);
  }

  try {
    deps.exec("open -a /Applications/cmux.app");
  } catch {
    // 尽力而为：cmux 可能已在跑，或 app 打开被阻止；capability 探测决定就绪度。
  }

  return waitForCmuxCapabilities(deps);
}

function buildRuntimeConfigDisclosure(platform: NodeJS.Platform): RuntimeConfigDisclosure[] {
  return platform === "darwin"
    ? [...BASE_RUNTIME_CONFIG_DISCLOSURE, DARWIN_RUNTIME_CONFIG_DISCLOSURE]
    : [...BASE_RUNTIME_CONFIG_DISCLOSURE];
}

async function probeDaemonCmuxStatus(doctorDeps?: DoctorDeps): Promise<"available" | "unavailable" | "skipped"> {
  const fetchFn = doctorDeps?.fetch;
  if (!fetchFn) return "skipped";
  const config = doctorDeps.configStore.resolve();
  const host = config.daemon.host;
  const port = config.daemon.port;

  try {
    const healthRes = await fetchFn(`http://${host}:${port}/healthz`);
    if (!healthRes.ok) return "skipped";
  } catch {
    return "skipped";
  }

  try {
    const cmuxRes = await fetchFn(`http://${host}:${port}/api/adapters/cmux/status`);
    if (!cmuxRes.ok || !cmuxRes.json) return "unavailable";
    const data = (await cmuxRes.json()) as { available?: boolean };
    return data.available ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

// Slice-03 Lane B（OPR.0.4.8）onboarding RECORD 路径。RULING-C（b4913ed4）：v1 onboarding 菜单
// 只把刻意的策略选择编辑/记录到一个已存在的 RigSpec 中——全新安装没有 spec，
// 所以什么都不写，底线靠缺席成立。持久化只走 RigSpec 的 `permission_policy`
// 字段（P6 围栏：不扩 config.json / 后台服务状态）。记录是最小破坏式
// YAML 编辑（parse -> 设一个键 -> serialize），绝不做可能丢键的 codec 重发。
//   选内置  -> permission_policy: builtin:<name>  （Seam-B 引用语义）
//   刻意 none -> permission_policy: none            （origin deliberate_none；底线==缺席）
// P3：记录只在显式 --policy 选择时跑，绝不在 skip/quit/timeout 时跑
//（无标志 => 无步骤 => 裸 setup 字节不变）。P1：这里没有路径会把缺席 spec 升级为 deliberate_none。
export const POLICY_CHOICES = ["locked", "standard", "open", "yolo", "none"] as const;
export type PolicyChoice = (typeof POLICY_CHOICES)[number];

// 根 spec 文件名，与 CLI 已确立的 file-or-directory spec 约定一致
//（见 specs.ts resolveAddSpecSource + `rig up <source>`）。
const ROOT_SPEC_NAMES = ["rig.yaml", "rig.yml", "agent.yaml", "agent.yml"];

function policyRefFor(choice: PolicyChoice): string {
  // Deliberate-none 是显式保留值；每个内置名都带强制 `builtin:` 前缀
  //（裸 canonical 名永不解析——反阴影，policy-ref.ts A1）。
  return choice === "none" ? "none" : `builtin:${choice}`;
}

/**
 * 把 `specPath` 解析为可读的已存在根 spec 文件，或 null。接受直接文件路径或
 * 含根 spec 的目录。用 deps.readFile 作为读+存在性探测（null = 缺席），所以
 * resolver 保持 fs 可注入，绝不铸造 spec——RULING-C：这里不做 scaffold 创作。
 */
export function resolveExistingSpecPath(deps: SetupDeps, specPath: string): string | null {
  if (deps.readFile(specPath) !== null) return specPath;
  for (const name of ROOT_SPEC_NAMES) {
    const candidate = path.join(specPath, name);
    if (deps.readFile(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * 把刻意的策略选择记录到已有 spec，返回 `policy_record` SetupStep。
 * 仅当操作人员显式传 --policy 时调用（P3）。未知选择或无可解析的已有 spec =>
 * `fail` 步骤，什么都不写（P1 + RULING-C 全新安装什么都不写）。
 */
export function recordPermissionPolicyStep(deps: SetupDeps, choice: string, specPath: string | undefined): SetupStep {
  if (!(POLICY_CHOICES as readonly string[]).includes(choice)) {
    return {
      id: "policy_record",
      status: "fail",
      message: `未知策略选择 '${choice}'。`,
      reason: `--policy 必须是以下之一：${POLICY_CHOICES.join(", ")}。`,
      fixHint: `用 --policy <${POLICY_CHOICES.join("|")}> 重跑。`,
    };
  }

  const resolved = specPath ? resolveExistingSpecPath(deps, specPath) : null;
  if (!resolved) {
    return {
      id: "policy_record",
      status: "fail",
      message: "没有可记录策略的已有 rig spec。",
      reason:
        "onboarding 菜单只把策略选择记录到已存在的 spec 中。全新安装没有 spec，所以什么都不写——可用性底线靠缺席成立。",
      fixHint: "把 --spec 指向一个已有 rig.yaml（或含它的目录），然后重跑 `zrig setup --policy`。",
    };
  }

  const ref = policyRefFor(choice as PolicyChoice);
  try {
    const raw = deps.readFile(resolved) ?? "";
    // 保留注释的最小破坏式编辑：parseDocument 保留注释文本（顶部 + 行内）、
    // 键顺序、引号与结构；我们只设 permission_policy 键再序列化。
    //（诚实 API 限制：`#` 前的填充可能归一化——这是文本/结构保留，不是任意空白的字节镜像。）
    // 单纯 parse->stringify 会丢掉所有注释——上面的测试已 pin 住这一点。
    const doc = parseDocument(raw);
    doc.set("permission_policy", ref);
    deps.writeFile(resolved, String(doc));
  } catch (err) {
    return {
      id: "policy_record",
      status: "fail",
      message: `无法把策略记录到 ${resolved}：${(err as Error).message}`,
      reason: "spec 无法解析或写入；未应用部分修改。",
      fixHint: "修复 spec YAML，然后重跑 `zrig setup --policy`。",
    };
  }

  return {
    id: "policy_record",
    status: "applied",
    message:
      choice === "none"
        ? `已把刻意的无策略选择（permission_policy: none）记录到 ${resolved}。`
        : `已把 permission_policy: ${ref} 记录到 ${resolved}。`,
  };
}

export async function runSetup(deps: SetupDeps, opts: { dryRun?: boolean; full?: boolean; policy?: string; specPath?: string; doctorDeps?: DoctorDeps }): Promise<SetupResult> {
  const profile = opts.full ? "full" : "core";
  const platform = deps.platform ?? process.platform;
  const runtimeConfig = buildRuntimeConfigDisclosure(platform);
  const stepIds = opts.full ? [...CORE_STEP_IDS, ...FULL_EXTRA_STEP_IDS] : [...CORE_STEP_IDS];
  const steps: SetupStep[] = [];

  if (opts.dryRun) {
    for (const id of stepIds) {
      steps.push({ id, status: "skipped", message: `Dry run：会尝试 ${id}。` });
    }
    if (opts.policy !== undefined) {
      steps.push({ id: "policy_record", status: "skipped", message: `Dry run：会为 '${opts.policy}' 记录 permission_policy。` });
    }
    return { profile, platform, ready: false, steps, runtimeConfig };
  }

  // 核心步骤
  // 1. Homebrew（macOS 优先的 setup 路径）
  let brewOk = false;
  if (platform !== "darwin") {
    steps.push({
      id: "brew",
      status: "skipped",
      message: "跳过：Homebrew setup 路径仅在 macOS 上使用。",
    });
  } else {
    try {
      deps.exec("brew --version");
      brewOk = true;
      steps.push({ id: "brew", status: "pass", message: "Homebrew 可用。" });
    } catch {
      steps.push({
        id: "brew",
        status: "fail",
        message: "未找到 Homebrew。",
        reason: "macOS 上安装 tmux 和 cmux 需要 Homebrew。",
        fixHint: "安装 Homebrew：https://brew.sh",
      });
    }
  }

  // 2. tmux
  const tmuxProbe = probeTmuxControl((cmd) => deps.exec(cmd));
  if (tmuxProbe.code === "not_installed") {
    if (!brewOk) {
      steps.push({ id: "tmux_install", status: "skipped", message: "跳过：Homebrew 不可用。", reason: "安装 tmux 需要 Homebrew。" });
    } else {
      try {
        installCommand(deps, "brew install tmux");
        steps.push({ id: "tmux_install", status: "applied", message: "已用 Homebrew 安装 tmux。" });
      } catch (err) {
        steps.push({ id: "tmux_install", status: "fail", message: `安装 tmux 失败：${(err as Error).message}` });
      }
    }
  } else if (!tmuxProbe.available) {
    const failure = buildTmuxControlFailure(tmuxProbe.detail ?? "未知 tmux 控制失败");
    steps.push({
      id: "tmux_install",
      status: "fail",
      message: failure.message,
      reason: failure.reason,
      fixHint: failure.fix,
    });
  } else {
    steps.push({ id: "tmux_install", status: "pass", message: "tmux 可用。" });
  }

  // 3. cmux
  const daemonCmuxBefore = await probeDaemonCmuxStatus(opts.doctorDeps);
  if (await waitForCmuxCapabilities(deps, 1)) {
    const socketMode = readCmuxSocketControlModeFromText(deps.readFile(resolveCmuxSettingsPath()));
    if (platform === "darwin" && socketMode.error) {
      steps.push({
        id: "cmux_install",
        status: "fail",
        message: "cmux 设置文件不可读。",
        reason: `zrig 无法解析 ${CMUX_SETTINGS_DISCLOSURE_PATH}：${socketMode.error}`,
        fixHint: "修复或删除 cmux 设置文件，然后重跑 `zrig setup`。",
      });
    } else if (platform === "darwin" && !isCmuxSocketControlCompatible(socketMode.mode)) {
      if (await tryEnableCmuxControl(deps, platform)) {
        const daemonCmuxAfter = await probeDaemonCmuxStatus(opts.doctorDeps);
        if (daemonCmuxAfter === "unavailable") {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: "zrig 已更新 cmux 设置，但运行中的后台服务仍无法控制 cmux。",
            reason: "cmux 设置文件现在已兼容，所以剩余阻塞在活动后台服务/cmux 会话状态里。",
            fixHint: "用 `zrig daemon start` 重启后台服务，然后重跑 `zrig doctor` 确认 cmux 后台服务控制。",
          });
        } else {
          steps.push({
            id: "cmux_install",
            status: "applied",
            message: "已在 ~/.config/cmux/settings.json 中把 cmux socket 控制归一化为 automation 模式。",
          });
        }
      } else {
        steps.push({
          id: "cmux_install",
          status: "fail",
          message: "cmux shell 控制可用，但 zrig 无法归一化 cmux socket 控制。",
          reason: "zrig 需要兼容的 cmux socket 控制模式，后台服务才能可靠打开 CMUX 界面。",
          fixHint: `在 ${CMUX_SETTINGS_DISCLOSURE_PATH} 中把 automation.socketControlMode 设为 "automation"，然后重跑 \`zrig setup\` 或 \`zrig doctor\`。`,
        });
      }
    } else if (daemonCmuxBefore === "unavailable") {
      steps.push({
        id: "cmux_install",
        status: "fail",
        message: "cmux shell 控制可用，但运行中的后台服务仍无法控制 cmux。",
        reason: "当前 cmux 设置看起来已兼容，所以剩余阻塞在 zrig 无法自动修复的 cmux 设置文件之外。",
        fixHint: "跑 `zrig doctor` 看后台服务 cmux 的确切诊断，清除底层阻塞后重启后台服务。",
      });
    } else {
      steps.push({ id: "cmux_install", status: "pass", message: "cmux 可用。" });
    }
  } else {
    try {
      deps.exec("cmux --help");

      if (await tryEnableCmuxControl(deps, platform)) {
        const daemonCmuxAfter = await probeDaemonCmuxStatus(opts.doctorDeps);
        if (daemonCmuxAfter === "unavailable") {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: "zrig 已启用 cmux socket 控制，但运行中的后台服务仍无法控制 cmux。",
            reason: "cmux app 和设置已就位，所以剩余阻塞在活动后台服务/cmux 会话状态里。",
            fixHint: "用 `zrig daemon start` 重启后台服务，然后重跑 `zrig doctor` 确认 cmux 后台服务控制。",
          });
        } else {
          steps.push({
            id: "cmux_install",
            status: "applied",
            message: "已在 ~/.config/cmux/settings.json 中启用 cmux socket 控制。",
          });
        }
      } else {
        steps.push({
          id: "cmux_install",
          status: platform === "darwin" ? "fail" : "warn",
          message: "cmux 已安装，但控制不可用。",
          reason: "开放 CMUX 工作流需要启用 cmux socket 控制。",
          fixHint: platform === "darwin"
            ? `在 ${CMUX_SETTINGS_DISCLOSURE_PATH} 中把 automation.socketControlMode 设为 "automation"，然后重跑 \`zrig setup\` 或 \`zrig doctor\`.`
            : "打开 cmux，批准首次运行提示，然后重跑 `zrig setup` 或 `zrig doctor`。",
        });
      }
    } catch {
      if (!brewOk) {
        steps.push({ id: "cmux_install", status: "skipped", message: "跳过：Homebrew 不可用。" });
      } else {
        try {
          installCommand(deps, "brew install --cask cmux");
          if (await tryEnableCmuxControl(deps, platform) || await waitForCmuxCapabilities(deps, 1)) {
            steps.push({ id: "cmux_install", status: "applied", message: "已用 Homebrew 安装 cmux。" });
          } else {
            steps.push({
              id: "cmux_install",
              status: platform === "darwin" ? "fail" : "warn",
              message: "已安装 cmux，但控制仍不可用。",
              reason: "开放 CMUX 工作流需要 cmux app 在安装后暴露 socket 控制。",
              fixHint: "打开 cmux，批准首次运行提示，然后重跑 `zrig setup` 或 `zrig doctor`。",
            });
          }
        } catch (err) {
          steps.push({
            id: "cmux_install",
            status: "fail",
            message: `安装 cmux 失败：${(err as Error).message}`,
            reason: "在 cmux app 和 CLI 装好之前，开放 CMUX 工作流保持不可用。",
            fixHint: "网络稳定后重试 `brew install --cask cmux`，或手动安装 cmux。",
          });
        }
      }
    }
  }

  // 4. tmux config
  // 4. Claude Code 运行时
  let claudeInstalled = false;
  try {
    deps.exec("claude --version");
    claudeInstalled = true;
    steps.push({ id: "claude_install", status: "pass", message: "Claude Code 可用。" });
  } catch {
    try {
      installCommand(deps, "npm install -g @anthropic-ai/claude-code");
      deps.exec("claude --version");
      claudeInstalled = true;
      steps.push({ id: "claude_install", status: "applied", message: "已用 npm 安装 Claude Code。" });
    } catch (err) {
      steps.push({
        id: "claude_install",
        status: "fail",
        message: `安装 Claude Code 失败：${(err as Error).message}`,
        reason: "Claude Code 席位需要 Claude CLI；纯 Codex 项目可以用自己的运行时就绪结果。",
        fixHint: "用 `npm install -g @anthropic-ai/claude-code` 安装 Claude Code。",
      });
    }
  }

  if (claudeInstalled) {
    try {
      deps.exec("claude auth status");
      steps.push({ id: "claude_auth", status: "pass", message: "Claude Code 认证可用。" });
    } catch (err) {
      steps.push({
        id: "claude_auth",
        status: "fail",
        message: `Claude Code 已安装但尚不能启动：${(err as Error).message}`,
        reason: "Claude Code 席位在 Claude CLI 登录可用前不能启动。",
        fixHint: "跑 `claude auth login` 或打开一次 `claude` 完成认证，然后重跑 `zrig setup` 或 `zrig doctor`。",
      });
    }
  } else {
    steps.push({
      id: "claude_auth",
      status: "skipped",
      message: "跳过：Claude Code 未安装。",
      reason: "在 Claude Code CLI 装好前无法检查认证。",
    });
  }

  // 5. Codex 运行时
  let codexInstalled = false;
  try {
    deps.exec("codex --version");
    codexInstalled = true;
    steps.push({ id: "codex_install", status: "pass", message: "Codex 可用。" });
  } catch {
    try {
      installCommand(deps, "npm install -g @openai/codex");
      deps.exec("codex --version");
      codexInstalled = true;
      steps.push({ id: "codex_install", status: "applied", message: "已用 npm 安装 Codex。" });
    } catch (err) {
      steps.push({
        id: "codex_install",
        status: "fail",
        message: `安装 Codex 失败：${(err as Error).message}`,
        reason: "Codex 席位需要本机安装 Codex CLI。",
        fixHint: "用 `npm install -g @openai/codex` 安装 Codex。",
      });
    }
  }

  if (codexInstalled) {
    try {
      deps.exec("codex login status");
      steps.push({ id: "codex_auth", status: "pass", message: "Codex 认证可用。" });
    } catch (err) {
      steps.push({
        id: "codex_auth",
        status: "fail",
        message: `Codex 已安装但尚不能启动：${(err as Error).message}`,
        reason: "Codex 席位在 Codex CLI 登录可用前不能启动。",
        fixHint: "跑 `codex login` 完成认证，然后重跑 `zrig setup` 或 `zrig doctor`。",
      });
    }
  } else {
    steps.push({
      id: "codex_auth",
      status: "skipped",
      message: "跳过：Codex 未安装。",
      reason: "在 Codex CLI 装好前无法检查认证。",
    });
  }

  // 6. tmux config
  const TMUX_CONF = `${process.env["HOME"] ?? "~"}/.tmux.conf`;
  const MANAGED_MARKER = "# OpenRig managed block";
  const MANAGED_BLOCK = [
    MANAGED_MARKER,
    "set -g mouse on",
    "set -g history-limit 50000",
    `# End ${MANAGED_MARKER}`,
  ].join("\n");

  try {
    const existing = deps.readFile(TMUX_CONF);
    if (existing && existing.includes(MANAGED_MARKER)) {
      // 替换已有 managed 块
      const replaced = existing.replace(
        new RegExp(`${MANAGED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?# End ${MANAGED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        MANAGED_BLOCK,
      );
      deps.writeFile(TMUX_CONF, replaced);
      steps.push({ id: "tmux_config", status: "applied", message: "已更新 zrig 托管的 tmux 配置块。" });
    } else if (existing) {
      deps.writeFile(TMUX_CONF, existing.trimEnd() + "\n\n" + MANAGED_BLOCK + "\n");
      steps.push({ id: "tmux_config", status: "applied", message: "已追加 zrig 托管的 tmux 配置块。" });
    } else {
      deps.writeFile(TMUX_CONF, MANAGED_BLOCK + "\n");
      steps.push({ id: "tmux_config", status: "applied", message: "已创建带 zrig 托管块的 .tmux.conf。" });
    }
  } catch (err) {
    steps.push({ id: "tmux_config", status: "warn", message: `无法更新 tmux 配置：${(err as Error).message}` });
  }

  // 7. 校验
  const tmuxOk = steps.some((s) => s.id === "tmux_install" && (s.status === "pass" || s.status === "applied"));
  const anyFail = steps.some((s) => s.status === "fail");
  steps.push({
    id: "verify",
    status: anyFail ? "warn" : "pass",
    message: anyFail ? "部分 setup 步骤失败。跑 `zrig doctor` 看详细诊断。" : "核心 setup 已校验。",
  });

  // Full profile 额外项
  if (opts.full) {
    for (const tool of [{ id: "jq_install", cmd: "jq", brew: "jq" }, { id: "gh_install", cmd: "gh", brew: "gh" }]) {
      try {
        deps.exec(`${tool.cmd} --version`);
        steps.push({ id: tool.id, status: "pass", message: `${tool.cmd} 可用。` });
      } catch {
        if (!brewOk) {
          steps.push({ id: tool.id, status: "skipped", message: `跳过：Homebrew 不可用。` });
        } else {
          try {
            installCommand(deps, `brew install ${tool.brew}`);
            steps.push({ id: tool.id, status: "applied", message: `已用 Homebrew 安装 ${tool.cmd}。` });
          } catch {
            steps.push({ id: tool.id, status: "warn", message: `安装 ${tool.cmd} 失败。`, fixHint: `手动安装 ${tool.cmd}。` });
          }
        }
      }
    }
  }

  // 非 dry-run 且有 doctorDeps 时跑 doctor 支持的校验
  let verification: SetupResult["verification"];
  if (!opts.dryRun && opts.doctorDeps) {
    const doctorDeps = opts.doctorDeps;
    const doctor = runDoctorChecks(doctorDeps);
    const asyncResults = await Promise.all(doctor.asyncChecks);
    const allDoctorChecks = [...doctor.checks, ...asyncResults];
    verification = {
      checks: allDoctorChecks.map((c) => ({
        name: c.name,
        status: c.status,
        message: c.message,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.fix ? { fix: c.fix } : {}),
      })),
    };
  }

  // P3：只在显式传 --policy 时记录刻意的策略选择（绝不在裸跑时记录）。
  // 无标志 => 无 policy_record 步骤 => 裸 setup 字节不变（锚点 1）。
  if (opts.policy !== undefined) {
    steps.push(recordPermissionPolicyStep(deps, opts.policy, opts.specPath));
  }

  // ready = steps 或 verification checks 中无 fail 状态
  const stepsFailed = steps.some((s) => s.status === "fail");
  const verificationFailed = verification?.checks.some((c) => c.status === "fail") ?? false;
  const ready = !stepsFailed && !verificationFailed;
  return { profile, platform, ready, steps, runtimeConfig, ...(verification ? { verification } : {}) };
}

function buildDefaultDoctorDeps(setupDeps: SetupDeps): DoctorDeps {
  const platform = setupDeps.platform ?? process.platform;
  const baseDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return {
    exists: setupDeps.exists,
    baseDir,
    readFile: setupDeps.readFile,
    exec: setupDeps.exec,
    checkPort: async (port: number) => {
      const net = await import("node:net");
      return new Promise<boolean>((resolve) => {
        const socket = new net.default.Socket();
        socket.once("connect", () => { socket.destroy(); resolve(false); });
        socket.once("error", () => resolve(true));
        socket.connect(port, "127.0.0.1");
      });
    },
    configStore: new ConfigStore(),
    platform: platform as NodeJS.Platform,
    mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
    checkWritable: (p: string) => accessSync(p, constants.W_OK),
    fetch: globalThis.fetch,
  };
}

/**
 * OPR.0.3.3.04.2（AC-1）：在已有动词之上的唯一 canonical 有序黄金路径——
 * 不搞魔法 mega-command，不藏状态。`rig setup` 把它作为下一步打印；
 * `rig status`/`rig doctor` 只回指它；持久参考是 docs/reference/getting-started.md。
 * 返回要打印的行。
 */
export function goldenPathNextSteps(): string[] {
  return [
    "下一步（引导路径；完整参考：docs/reference/getting-started.md）：",
    "  1. cd <你的仓库>                 选团队要工作的代码",
    "  2. zrig up first-project --cwd .  启动 owner + checker（Codex）；自动启动后台服务与 kernel",
    "  3. zrig status                     检查后台服务/kernel 就绪；zrig ps --nodes --rig first-project 检查团队",
    "  4. zrig send dev-owner@first-project '<一条有用的改动、边界、以及怎么检查>'",
    "  5. zrig tui --shared              加入 kernel 看板；裸 zrig tui 打开你自己的视图",
    "  接下来：zrig queue list --rig first-project；zrig workspace doctor；zrig scope ...；zrig workflow specs",
  ];
}

/**
 * Slice-03 Lane B（OPR.0.4.8）onboarding 菜单文案。0.4.8 这一脉没有 TUI，
 * 所以"菜单"是平静登记的叙事文本，呈现权限策略选择。文案已冻结 + 创始人钦定
 *（missions/.../MENU-COPY-FROZEN-2026-08-04）：逐字 `Policy Mode`/`YOLO Mode` 标签，
 * "Operator"这个名字从不出现（YOLO Mode 是它面向用户的标签），刻意-none 与
 * 跳过行的确切措辞，无预选默认，`Standard` 带 ⭐ 推荐标记。
 * 登记规则（pm-lead）：事实 + 版本中立——绝不"奸诈"/说教/创始人内部措辞。
 * 记录是想法，绝不是门槛——`rig up` 永远能裸跑。
 */
export function permissionPolicyMenuLines(): string[] {
  return [
    "权限策略（可选——记录是想法，不是门槛；`zrig up` 没有它也永远能跑）：",
    "  Policy Mode：",
    "    Locked            最严格的内置策略。",
    "    Standard  ⭐      推荐的平衡内置策略。",
    "    Open              最宽松的内置策略。",
    "  YOLO Mode           完全旁路的内置策略。",
    "  无策略——刻意选择（已记录）",
    "",
    "  如果你跳过：zrig 什么都不设——只有可用性底线",
    "",
    "  要把选择记录到已有 spec：",
    "    zrig setup --policy <locked|standard|open|yolo|none> --spec <path>",
  ];
}

export function setupCommand(depsOverride?: SetupDeps): Command {
  const cmd = new Command("setup").description("为 zrig 准备本机");

  cmd
    .option("--dry-run", "展示计划但不做修改")
    .option("--json", "机器可读 JSON 输出")
    .option("--full", "安装更广泛的操作人员工作站工具")
    .option("--policy <name>", `把刻意的权限策略选择记录到已有 spec（${POLICY_CHOICES.join("|")}）`)
    .option("--spec <path>", "要记录 --policy 选择的已有 rig spec（文件或目录）")
    .action(async (opts: { dryRun?: boolean; json?: boolean; full?: boolean; policy?: string; spec?: string }) => {
      const deps = depsOverride ?? defaultDeps();
      const doctorDeps = opts.dryRun ? undefined : buildDefaultDoctorDeps(deps);
      const result = await runSetup(deps, { dryRun: opts.dryRun, full: opts.full, policy: opts.policy, specPath: opts.spec, doctorDeps });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!opts.dryRun && !result.ready) process.exitCode = 1;
        return;
      }

      console.log(`\nProfile：${result.profile}`);
      console.log(`平台：${result.platform}\n`);
      console.log("zrig 可能在以下位置修改运行时配置：");
      for (const item of result.runtimeConfig) {
        console.log(`  - [${item.scope}] ${item.runtime} ${item.path} — ${item.purpose}`);
      }
      console.log("  - 注意：已在跑的已认领会话可能需要重启才能拿到运行时配置改动。\n");

      for (const step of result.steps) {
        const icon = step.status === "pass" ? "OK" : step.status === "applied" ? "APPLIED" : step.status === "warn" ? "WARN" : step.status === "skipped" ? "SKIP" : "FAIL";
        console.log(`  [${icon}] ${step.id}：${step.message}`);
        if (step.reason) console.log(`       原因：${step.reason}`);
        if (step.fixHint) console.log(`       修复：${step.fixHint}`);
      }

      // 暴露权限策略选择（0.4.8 onboarding "菜单"是平静登记的叙事，不是 TUI）。
      // 记录是可选的，绝不是门槛。
      console.log("");
      for (const line of permissionPolicyMenuLines()) console.log(line);

      // OPR.0.3.3.04.2（AC-1）：canonical 有序黄金路径。`rig setup` 是新操作人员
      // 序列的主要接口（status/doctor 只回指它；持久参考是
      // docs/reference/getting-started.md）。
      if (result.ready) {
        console.log("\nSetup 完成。\n");
        for (const line of goldenPathNextSteps()) console.log(line);
      } else {
        console.log("\n部分步骤需要关注。跑 `zrig doctor` 看详细诊断。");
        console.log("Setup 健康后，按引导路径走：docs/reference/getting-started.md");
      }
      if (!opts.dryRun && !result.ready) process.exitCode = 1;
    });

  return cmd;
}
