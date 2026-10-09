import { DeliveryGuardError, type SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";

export type ExecFn = (cmd: string) => Promise<string>;

/**
 * `sendText` 可注入的文件/缓冲区操作。单独抽出后，测试无需触碰真实文件系统即可观察临时文件
 * 写入和唯一名称生成；生产环境接入 Node fs + os.tmpdir。
 */
export interface TmuxFileOps {
  writeFile(path: string, content: string, options?: { mode: number; flag: "wx" }): Promise<void>;
  unlink(path: string): Promise<void>;
  /** 每次调用使用唯一临时文件路径——并行 `rig up` 会启动多个席位。 */
  tmpName(): string;
  /** 每次调用使用唯一 tmux buffer 名称——固定名称会在并发时冲突。 */
  bufferName(): string;
}

function defaultTmuxFileOps(): TmuxFileOps {
  return {
    writeFile: (p, content, options) => fsWriteFile(p, content, { encoding: "utf8", ...options }),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

export type TmuxResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  index: number;
  cwd: string;
  width: number;
  height: number;
  active: boolean;
}

/**
 * 光标坐标与 pane 几何尺寸，用于实时终端初始化（OPR.0.4.0.38）。坐标从零开始，几何尺寸是
 * 可见 pane 大小。源自 FR-4 seed 工作，使新订阅者可在正确光标位置绘制当前屏幕且不发生行漂移。
 */
export interface TmuxCursorPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 已连接的 tmux 客户端——人类使用的终端/CMUX 磁贴。`name` 是 `switch-client -c` 接受的
 * 客户端标识符（默认为客户端 tty）；`session` 是客户端当前正在查看的 session（可能是错误或
 * 已死亡视图，这正是 OPR.0.4.3.26 恢复所重定向的情形）。
 */
export interface TmuxClient {
  name: string;
  session: string;
}

/**
 * 分类后的 session 探测结果（OPR.0.5.4.2）。`absent` 携带正向 tmux 证据；
 * `transport_unavailable` 表示无法访问 tmux server，且未确定 session 是否存在——二者绝不可
 * 互换。
 */
export type SessionProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "transport_unavailable"; cause: string };

const TMUX_FIELD_SEPARATOR = "|";
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
].join(TMUX_FIELD_SEPARATOR);
const WINDOW_FORMAT = "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}";
// tmux 3.6 会把 -F 输出中的字面控制字符清理为下划线，导致 tab 分隔的 session 与 pane 行无法
// 解析。因此，这些 adapter 所有的格式改用可打印分隔符。
const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(TMUX_FIELD_SEPARATOR);
const CLIENT_FORMAT = "#{client_name}\t#{client_session}";

function isNoServerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no server running");
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session not found") ||
    msg.includes("can't find session") ||
    msg.includes("no current target") ||
    msg.includes("no session");
}

function isPaneAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("can't find pane") || msg.includes("pane not found") || msg.includes("no such pane");
}

// 重启后，/tmp/tmux-<uid>/<name> 的 tmux socket 文件会消失，因此 `tmux has-session` 以非零
// 状态退出并给出 transport 缺失消息，而非 server/session 缺失消息。probeSession() 将此类归为
// transport_unavailable——未确定 session 是否存在，绝不等同于缺失；只有 Reconciler 在自己的
// 冷启动调用点选择把该状态视为可分离（OPR.0.5.4.2）。权限错误必须继续重新抛出。
function isTmuxTransportAbsentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // 关闭失败：绝不把权限/授权失败归类为缺失。
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(msg)) {
    return false;
  }
  // tmux socket transport 失败前缀；括号内说明原因。
  //   "error connecting to /private/tmp/tmux-501/default (No such file or directory)"
  //   "error connecting to /private/tmp/tmux-501/default (Connection refused)"
  if (msg.startsWith("error connecting to")) {
    return /No such file or directory|Connection refused/.test(msg);
  }
  // 仍引用 tmux socket 路径的保守裸消息变体。
  if (/tmux-\d+/.test(msg) && /No such file or directory|Connection refused/.test(msg)) {
    return true;
  }
  return false;
}

function classifyWriteError(err: unknown): TmuxResult {
  if (err instanceof DeliveryGuardError) return { ok: false, code: err.code, message: err.message };
  if (!(err instanceof Error)) {
    return { ok: false, code: "unknown", message: String(err) };
  }
  if (err.message.includes("duplicate session")) {
    return { ok: false, code: "duplicate_session", message: err.message };
  }
  if (err.message.includes("can't find session") || err.message.includes("no server running")) {
    return { ok: false, code: "session_not_found", message: err.message };
  }
  return { ok: false, code: "unknown", message: err.message };
}

/** 使用单引号为字符串添加 shell 引号（POSIX 安全）。 */
function shellQuote(s: string): string {
  // 将每个 ' 替换为 '"'"'（结束引号、用双引号包裹撇号、恢复引号）。
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 4) return null;
  const windows = parseInt(parts[1]!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts[0]!,
    windows,
    created: parts[2]!,
    attached: parts[3] === "1",
  };
}

function parseClientLine(line: string): TmuxClient | null {
  const parts = line.split("\t");
  if (parts.length < 2) return null;
  const name = parts[0]!;
  if (name === "") return null;
  return {
    name,
    session: parts[1]!,
  };
}

function parseWindowLine(line: string): TmuxWindow | null {
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const index = parseInt(parts[0]!, 10);
  const panes = parseInt(parts[2]!, 10);
  if (isNaN(index) || isNaN(panes)) return null;
  return {
    index,
    name: parts[1]!,
    panes,
    active: parts[3] === "1",
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length < 6) return null;
  const index = parseInt(parts[1]!, 10);
  const width = parseInt(parts[3]!, 10);
  const height = parseInt(parts[4]!, 10);
  if (isNaN(index) || isNaN(width) || isNaN(height)) return null;
  return {
    id: parts[0]!,
    index,
    cwd: parts[2]!,
    width,
    height,
    active: parts[5] === "1",
  };
}

function parseLines<T>(output: string, parser: (line: string) => T | null): T[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

export class TmuxAdapter {
  deliveryGuard?: SeatDeliveryGuard;
  private readonly freshProbes = new Map<string, string>();
  private readonly freshManaged = new Map<string, {nodeId: string; pane: string}>();

  /** 只有私有元数据探针使用此入口。成功只能证明已分配，绝不证明对既有或 registry 托管目标
   * 拥有权限。 */
  async createProbeSession(name: string, cwd?: string): Promise<TmuxResult> {
    if (this.deliveryGuard?.maybeTarget(name)) return { ok: false, code: "guard_target_managed", message: "探针不能复用托管席位。" };
    const created = await this.createSessionUnchecked(name, cwd);
    if (!created.ok) return created;
    try {
      const panes = await this.listPanes(name);
      if (panes.length === 1) { this.freshProbes.set(name, panes[0]!.id); this.freshProbes.set(panes[0]!.id, panes[0]!.id); return created; }
    } catch { /* 没有目标凭证，不写入输入。 */ }
    return { ok: false, code: "guard_target_unknown", message: "无法建立新的探针 pane；未写入输入。" };
  }

  private async guardedInput(target: string, write: (pane: string, beforeWrite: () => void) => Promise<TmuxResult>, allowAbsent = false): Promise<TmuxResult> {
    const guard = this.deliveryGuard;
    if (!guard) return write(target, () => {});
    try {
      const probePane = this.freshProbes.get(target);
      if (probePane && !guard.maybeTarget(target)) {
        const panes = await this.listPanes(target);
        if (panes.length !== 1 || panes[0]!.id !== probePane) throw new Error("私有探针目标已变化；未写入输入。");
        return write(probePane, () => {});
      }
      const created = this.freshManaged.get(target);
      const identity = created?.nodeId ?? target;
      return await guard.input(identity, async () => {
        const bound = guard.target(identity);
        const fresh = created?.nodeId === bound.nodeId && guard.ownsLifecycle(bound.nodeId);
        let panes: TmuxPane[];
        try { panes = await this.listPanes(fresh ? target : bound.session); }
        catch (error) {
          guard.checkInput(identity);
          const result = classifyWriteError(error);
          // 只有终止操作会消费确定缺失。未知探针失败仍会拒绝，guard 开启时永远不会到达此观察。
          if (allowAbsent && !result.ok && result.code === "session_not_found"
            && !/permission denied|operation not permitted|EACCES|EPERM/i.test(result.message)) return result;
          throw error;
        }
        const pane = fresh ? created.pane : bound.pane;
        if (!pane || panes.length !== 1 || panes[0]!.id !== pane) throw new Error("托管 pane 身份不可用或已变化；未写入输入。");
        // 异步观察后重新验证 registry/occupant。写入不可变 pane ID，而不是可能被复用的 session 名称。
        return guard.input(identity, () => write(pane, () => guard.checkInput(identity)));
      });
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: String((error as Error).message) };
    }
  }


  /** 显式内部人工输入；transport HTTP 选项无法选择此路径。 */
  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.humanInput(target, fn) : fn();
  }

  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.operation(target, fn) : fn();
  }

  constructor(private exec: ExecFn, private fileOps: TmuxFileOps = defaultTmuxFileOps()) {}

  /** 启动空的原生终端 server，不捏造席位/session。 */
  async startServer(): Promise<TmuxResult> {
    const probeName = `openrig-startup-${randomUUID()}`;
    try {
      if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      // tmux -D 让空 server 保持存活。原生 socket 所有权仲裁并发启动；证明可用性的是下方
      // 读回，而不是 shell 退出。
      await this.exec("tmux -D </dev/null >/dev/null 2>&1 &");
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((await this.probeSession(probeName)).state !== "transport_unavailable") return { ok: true };
      }
      return { ok: false, code: "tmux_unavailable", message: "终端 server 未变为可用；请检查 tmux 及其 socket 权限。" };
    } catch (error) {
      return { ok: false, code: "tmux_unavailable", message: `终端 server 不可用：${(error as Error).message}` };
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.exec(`tmux list-sessions -F "${SESSION_FORMAT}"`);
      return parseLines(output, parseSessionLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.exec(`tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    try {
      const output = await this.exec(`tmux list-panes -t ${shellQuote(target)} -F "${PANE_FORMAT}"`);
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * 分类后的 session 探针（OPR.0.5.4.2）：tmux 产生的三类错误是不同答案，adapter 不得替
   * 调用方把 transport 失败判断为缺失。
   * - `absent` 需要正向 tmux 证据（can't-find-session 类）。
   * - `transport_unavailable` 是无 server/socket 消失类：未确定 session 是否存在。
   * - 意外探针失败（permission denied 等）会重新抛出，使调用方关闭失败，而不是把探针失败
   *   当成答案。
   */
  async probeSession(name: string): Promise<SessionProbe> {
    try {
      // 直接使用 `tmux has-session` 做可靠存在性检查，避免解析 `list-sessions` 的格式字符串输出；
      // 后者在不同 tmux 版本中 tab 分隔符格式异常时可能失败。
      await this.exec(`tmux has-session -t ${shellQuote(name)}`);
      return { state: "present" }; // 退出码 0 = session 存在。
    } catch (err) {
      if (isSessionAbsenceError(err)) {
        return { state: "absent" };
      }
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) {
        return { state: "transport_unavailable", cause: (err as Error).message };
      }
      throw err;
    }
  }

  /**
   * 折叠后的存在性视图。为绑定的 send/capture/nudge/walk 解析路径之外的消费者保留
   *（OPR.0.5.4.2 mini-req 6——它们采用此分类属于具名后续项）。必须区分 transport 短暂故障
   * 与缺失的调用方使用 probeSession()。
   */
  async hasSession(name: string): Promise<boolean> {
    const probe = await this.probeSession(name);
    return probe.state === "present";
  }

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "托管启动必须先获得生命周期租约，才能创建终端。" };
    }
    const result = await this.createSessionUnchecked(name, cwd, env);
    if (result.ok && this.deliveryGuard && env?.OPENRIG_NODE_ID) {
      try {
        const panes = await this.listPanes(name);
        if (panes.length === 1) this.freshManaged.set(name, {nodeId: env.OPENRIG_NODE_ID, pane: panes[0]!.id});
      } catch { /* 没有新 pane 凭证：后续写入继续被拒绝。 */ }
    }
    return result;
  }

  /** 已提交的绑定现在拥有身份；这不是文件系统清理。 */
  finishLaunchBinding(session: string): void { this.freshManaged.delete(session); }

  private async createSessionUnchecked(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    const cwdFlag = cwd != null ? ` -c ${shellQuote(cwd)}` : "";
    const envFlags = env
      ? Object.entries(env).map(([k, v]) => ` -e ${shellQuote(`${k}=${v}`)}`).join("")
      : "";
    const cmd = `tmux new-session -d -s ${shellQuote(name)}${cwdFlag}${envFlags}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * 粘贴任意大小的文本。无 bracket 输入可能被智能体 TUI 当作单个按键消费，即使低于旧 8 KiB
   * 截止值也会丢字。使用文件可避免 payload 字节进入 shell/tmux argv 及其大小限制。
   *   `-p`  接收应用启用该模式时，为粘贴加 bracket。
   *   `-r`  保留原始 LF。tmux 默认 paste-buffer 会把每个 LF 替换为 CR，而 CR（即 `C-m`、
   *         Enter）在 Claude/Codex TUI 中表示提交；默认粘贴多行包会在每个换行处提交。
   *   `-d`  成功粘贴后删除 buffer。
   * 唯一的尾部提交仍由调用方单独执行 `sendKeys(["C-m"])`。`finally` 中清理临时文件；若
   * buffer 已加载但粘贴失败（如目标缺失），显式执行 `delete-buffer`，避免泄漏 buffer。每次调用
   * 使用唯一临时文件和 buffer 名，避免并行 `rig up` 席位发生冲突。
   */
  async sendText(target: string, text: string): Promise<TmuxResult> {
    return this.guardedInput(target, (pane, beforeWrite) => this.sendTextUnchecked(pane, text, beforeWrite));
  }

  private async sendTextUnchecked(target: string, text: string, beforeWrite: () => void): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    try {
      await this.fileOps.writeFile(path, text);
      await this.exec(`tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`);
      bufferLoaded = true;
      beforeWrite();
      await this.exec(`tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r -p`);
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // load 后 paste 失败，`-d` 未运行，因此 buffer 仍驻留。尽力删除以避免泄漏。
        try {
          await this.exec(`tmux delete-buffer -b ${shellQuote(buffer)}`);
        } catch { /* 尽力清理。 */ }
      }
      return classifyWriteError(err);
    } finally {
      try {
        await this.fileOps.unlink(path);
      } catch { /* 尽力清理。 */ }
    }
  }

  /**
   * 在空 shell 中启动 POSIX 命令。新建 pane 仍可能处于 canonical 输入模式：在 macOS 上，
   * 即使 paste-buffer 成功，超过 1024 字节的输入也会被静默丢弃。只有简短调用跨过该边界；
   * 命令的 PATH、引号和参数通过文件传递。shell 在消费私有脚本时删除它，而不是在粘贴时删除。
   * 若 shell 从未消费调用，则保留文件供诊断。
   */
  async sendShellCommand(target: string, command: string, beforeInput?: () => void): Promise<TmuxResult> {
    return this.guardedInput(target, pane => this.sendShellCommandUnchecked(pane, command, beforeInput));
  }

  private async sendShellCommandUnchecked(target: string, command: string, beforeInput?: () => void): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const invocation = `/bin/sh ${shellQuote(path)}`;
    if (Buffer.byteLength(invocation, "utf8") > 512) {
      return { ok: false, code: "launch_path_too_long", message: "临时启动脚本路径超过安全终端输入上限" };
    }
    let created = false;
    try {
      await this.fileOps.writeFile(path, `/bin/rm -f -- ${shellQuote(path)}\n${command}\n`, { mode: 0o600, flag: "wx" });
      created = true;
      const text = beforeInput ? await this.guardedInput(target, (pane, check) => this.sendTextUnchecked(pane, invocation, () => { check(); beforeInput(); }))
        : await this.sendText(target, invocation);
      if (!text.ok) return text;
      const enter = beforeInput ? await this.guardedInput(target, pane => { beforeInput(); return this.sendKeysUnchecked(pane, ["Enter"]); })
        : await this.sendKeys(target, ["Enter"]);
      if (!enter.ok) {
        await this.sendKeys(target, ["C-c"]);
        return enter;
      }
      // 现在由接收方负责删除；在此 unlink 会与 shell 启动产生竞态。
      created = false;
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    } finally {
      if (created) {
        try { await this.fileOps.unlink(path); } catch { /* 尽力清理。 */ }
      }
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<TmuxResult> {
    return this.guardedInput(target, pane => this.sendKeysUnchecked(pane, keys));
  }

  private async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    const cmd = `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async setWindowOption(target: string, option: string, value: string): Promise<TmuxResult> {
    const cmd = `tmux set-option -w -t ${shellQuote(target)} ${shellQuote(option)} ${shellQuote(value)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult> {
    if (!Number.isFinite(cols) || !Number.isInteger(cols) || cols < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow：cols 必须是正整数，收到 ${cols}` };
    }
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return { ok: false, code: "validation_error", message: `resizeWindow：rows 必须是正整数，收到 ${rows}` };
    }
    const cmd = `tmux resize-window -t ${shellQuote(target)} -x ${cols} -y ${rows}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async killSession(name: string): Promise<TmuxResult> {
    if (this.deliveryGuard) {
      return this.guardedInput(name, async pane => {
        const stdout = await this.exec(`tmux display-message -p -t ${shellQuote(pane)} '#{session_id}'`);
        const sessionId = stdout.trim();
        if (!/^\$\d+$/.test(sessionId)) return { ok: false, code: "guard_target_unknown", message: "无法确认不可变 session 身份；未终止任何 session。" };
        const kill = async () => {
          const result = await this.killSessionUnchecked(sessionId);
          if (result.ok) { this.freshProbes.delete(name); this.freshProbes.delete(pane); this.freshManaged.delete(name); }
          return result;
        };
        if (this.freshProbes.get(name) === pane && !this.deliveryGuard!.maybeTarget(name) && !this.deliveryGuard!.maybeTarget(pane)) return kill();
        return this.deliveryGuard!.input(this.freshManaged.get(name)?.nodeId ?? name, kill);
      }, true);
    }
    return this.killSessionUnchecked(name);
  }

  private async killSessionUnchecked(name: string): Promise<TmuxResult> {
    const cmd = `tmux kill-session -t ${shellQuote(name)}`;
    try {
      await this.exec(cmd);
      const pane = this.freshProbes.get(name);
      this.freshProbes.delete(name);
      if (pane) this.freshProbes.delete(pane);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 席位 handover 切换（计划 411c43de）：原地 respawn pane（复用退役者的准确 pane），使继任者
   * 在前任历史下方启动；窗口相同、pane 相同，前任 scrollback 保留在启动内容上方。命令作为一个
   * 整体做 shell 引号处理（tmux 通过 shell 运行它）。
   *
   * ⚠ 不使用 `-k`：实测 tmux 3.6a 中 `respawn-pane -k` 会原子地强制终止并重生，同时清空 pane
   * scrollback，破坏关键证据。因此切换流程先终止退役者（优雅退出 + `setRemainOnExit(true)`，
   * 让 pane 在进程死亡后仍保留），等待 `isPaneDead`，再对已死亡 pane 调用不带 -k 的本方法，
   * 从而保留历史。respawn-pane 会拒绝仍存活的 pane（"still active"），这是正确守卫：绝不在
   * 活跃退役者之上 respawn。
   *
   * 可选 `cwd`/`env` 通过 respawn-pane 的 `-c`/`-e` 标志（tmux ≥3.0）把继任者启动目录与
   * OpenRig 身份环境注入复用 pane，与 createSession 使用同一机制。所有标志位于命令之前，
   * 命令始终位于最后。
   *
   * ⚠ KI-14：省略 `command` 会重新运行 pane 的创建命令（或上次 respawn 命令）；只有由
   * createSession 创建的 pane 才保证该命令是默认 shell。已接管/手工恢复的 pane 可能在此保存完整
   * harness 调用（`codex … resume <old-token>`），因此未定义命令的 respawn 会静默启动旧上下文。
   * 需要空 pane 的调用方必须传入显式 shell（见 getDefaultShell）。 */
  async respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<TmuxResult> {
    return this.guardedInput(paneTarget, pane => this.respawnPaneUnchecked(pane, command, opts));
  }

  private async respawnPaneUnchecked(paneTarget: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const cwdFlag = opts?.cwd != null ? ` -c ${shellQuote(opts.cwd)}` : "";
    const envFlags = opts?.env
      ? Object.entries(opts.env).map(([k, v]) => ` -e ${shellQuote(`${k}=${v}`)}`).join("")
      : "";
    const commandArg = command != null && command.length > 0 ? ` ${shellQuote(command)}` : "";
    const cmd = `tmux respawn-pane -t ${shellQuote(paneTarget)}${cwdFlag}${envFlags}${commandArg}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 席位 handover 切换：设置 pane 范围的 `remain-on-exit`，使退役进程退出时 pane 仍保留
   *（变为 dead 而非销毁），为继任者 respawn 保存 scrollback。必须在向退役者发送退出信号前设为
   * `on`，否则 pane 会在退出时销毁，没有可供 respawn 的位置。 */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult> {
    const cmd = `tmux set-option -p -t ${shellQuote(paneTarget)} remain-on-exit ${on ? "on" : "off"}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 席位 handover 切换：pane 进程是否已死亡（退役者退出，pane 由 remain-on-exit 保留）？
   * 已确认缺失的 pane 也能证明物理切换；未知探针错误仍返回 false。 */
  async isPaneDead(paneId: string): Promise<boolean> {
    try {
      const output = await this.exec(`tmux display-message -p -t ${shellQuote(paneId)} "#{pane_dead}"`);
      return output.trim() === "1";
    } catch (error) {
      return isNoServerError(error) || isPaneAbsenceError(error);
    }
  }

  /** 席位 handover 切换：向 pane 前台进程（退役者）发送信号；原地优雅退出用 `TERM`，有界超时
   * 强制回退用 `KILL`。解析 pane pid 后执行 `kill`；无法解析 pid 时返回结构化非抛出失败。 */
  async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    return this.guardedInput(paneId, (pane, beforeWrite) => this.signalPaneProcessUnchecked(pane, signal, beforeWrite));
  }

  private async signalPaneProcessUnchecked(paneId: string, signal: "TERM" | "KILL", beforeWrite: () => void): Promise<TmuxResult> {
    const pid = await this.getPanePid(paneId);
    if (pid == null) {
      return { ok: false, code: "pane_pid_unavailable", message: `无法解析 pane "${paneId}" 的 pid。` };
    }
    try {
      beforeWrite();
      await this.exec(`kill -${signal} ${pid}`);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 获取 pane 中前台进程的 PID；不可用时返回 null。 */
  async getPanePid(paneId: string): Promise<number | null> {
    try {
      const output = await this.exec(`tmux display-message -p -t ${shellQuote(paneId)} "#{pane_pid}"`);
      const trimmed = output.trim();
      const parsed = parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /** KI-14：server 的 `default-shell` 选项，即 createSession pane 未提供命令时运行的内容。
   * 用于让 respawn 明确使用空 shell，而不是继承 pane 创建时的任意命令。不可用时返回 null
   *（调用方回退）。 */
  async getDefaultShell(): Promise<string | null> {
    try {
      const output = await this.exec(`tmux show-options -gv default-shell`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** 获取 pane 当前前台命令；不可用时返回 null。 */
  async getPaneCommand(paneId: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux display-message -p -t ${shellQuote(paneId)} "#{pane_current_command}"`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** OPR.0.4.3.28 Part C——检查 session 环境变量是否可用。返回变量是否有非空值，绝不返回
   * 该值；无法检查 session 环境时返回 null。列出环境可以区分真正缺失的变量与
   * `tmux show-environment <var>` 查询时的非零退出。 */
  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    try {
      const output = await this.exec(`tmux show-environment -t ${shellQuote(sessionName)}`);
      const prefix = `${varName}=`;
      return output.split(/\r?\n/).some(
        (line) => line.startsWith(prefix) && line.slice(prefix.length).trim().length > 0,
      );
    } catch {
      return null;
    }
  }

  /** 启动 pipe-pane，将终端输出捕获到文件。 */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    // 对路径做 shell 引号处理，以安全注入 pipe-pane 命令。整个 pipe 命令作为单个参数传给 tmux，
    // 由其通过 sh -c 执行，因此路径使用 shellQuote。
    const cmd = `tmux pipe-pane -t ${shellQuote(sessionName)} ${shellQuote("cat >> " + shellQuote(outputPath))}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 停止 session 上的 pipe-pane。 */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const cmd = `tmux pipe-pane -t ${shellQuote(sessionName)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** 捕获 pane 内容（最后 N 行）；不可用时返回 null。 */
  async capturePaneContent(paneId: string, lines: number = 20): Promise<string | null> {
    try {
      const output = await this.exec(`tmux capture-pane -p -t ${shellQuote(paneId)} -S -${lines}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * 捕获 pane 当前可见屏幕（不含 scrollback）；不可用时返回 null。实时终端 seed
   *（OPR.0.4.0.38）必须使用可见屏幕，而不是 `-S -<lines>` scrollback；后者会重新引入
   * 绝对绘制 seed 原本要消除的行漂移。
   */
  async capturePaneScreen(paneId: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux capture-pane -p -t ${shellQuote(paneId)}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前光标坐标和 pane 几何尺寸。坐标从零开始。不可用或 tmux 返回非有限/越界值
   *（x<0、y<0、width<1、height<1）时返回 null，避免错误读取产生无效 seed。
   */
  async getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null> {
    try {
      const output = await this.exec(
        `tmux display-message -p -t ${shellQuote(paneId)} "#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}"`,
      );
      const [xRaw, yRaw, widthRaw, heightRaw] = output.trim().split("\t");
      const x = Number.parseInt(xRaw ?? "", 10);
      const y = Number.parseInt(yRaw ?? "", 10);
      const width = Number.parseInt(widthRaw ?? "", 10);
      const height = Number.parseInt(heightRaw ?? "", 10);
      if (![x, y, width, height].every(Number.isFinite)) return null;
      if (x < 0 || y < 0 || width < 1 || height < 1) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * 通过 `set-option -t <session>` 设置 SESSION 范围选项（OPR.0.4.6.02 N1 JSDoc 修复，
   * 架构）：这是通用 session 范围写入器，接受任何 session 选项，不只接受以 `@` 开头的用户
   * 选项（launcher 用它设置 `mouse`、`status` 等内置 session 选项）。SERVER 范围选项使用
   * `setServerOption`（`set-option -s`）；两种范围绝不交叉（守卫 b2）。
   */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    const cmd = `tmux set-option -t ${shellQuote(sessionName)} ${shellQuote(key)} ${shellQuote(value)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1（守卫 b2）：通过 `set-option -s <option> <value>` 设置 SERVER 范围
   * 选项，即后台服务配置自身 tmux server，而不是实时修改任何人的 session。绝不以 session
   *（`-t`）为目标：server 范围与 session 范围相互独立，绝不交叉。用于 `set-clipboard`/
   * `copy-command`。
   */
  async setServerOption(option: string, value: string): Promise<TmuxResult> {
    const cmd = `tmux set-option -s ${shellQuote(option)} ${shellQuote(value)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * OPR.0.4.6.02 S1：通过 `show-options -sv <option>` 读取 SERVER 范围选项值
   *（`-s` server 范围读取器，镜像 `setServerOption`）。未设置或出错时返回 null，用于测试/证明。
   */
  async showServerOption(option: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux show-options -sv ${shellQuote(option)}`);
      const v = output.trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** 获取 session 范围的用户选项值；未设置或出错时返回 null。 */
  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux show-option -v -t ${shellQuote(sessionName)} ${shellQuote(key)}`);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Slice 15——读取 pane 所在窗口最近一次活动的时间戳（Unix epoch 秒）。后台服务的
   * SeatActivityService 将它与已配置静默窗口比较：时间戳位于窗口内时，席位为
   * `terminal-active`；否则表示静默时间超过阈值。
   *
   * 为何不用 `pane_silence_flag`：slice 15 dogfood 时观察到 tmux 3.6a 对
   * `#{pane_silence_flag}` 返回空值（sticky-alert 行为 + 依赖版本的 emit 语义），因此不能作为
   * 主要信号。`#{window_activity}` 会可靠填充（窗口每次收到输出时由 runtime 更新），也是 tmux
   * status-line 活动指示器自身使用的时间戳。
   *
   * 返回值：
   *   - runtime 公开该值时，返回 Unix epoch 秒整数
   *   - 目标缺失或值无法解析时返回 `null`
   *     （消费者把 null 视为“无信号”，与“idle”区分）。
   */
  async readPaneLastActivity(paneId: string): Promise<number | null> {
    try {
      const output = await this.exec(
        `tmux display-message -p -t ${shellQuote(paneId)} '#{window_activity}'`,
      );
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    } catch {
      return null;
    }
  }

  /**
   * OPR.0.4.3.26——列出连接到 server 的 tmux 客户端（人工终端/CMUX 磁贴）。仅查看探针：
   * 绝不修改路由、绑定或 session。镜像 `listSessions` 的读取/解析/吞错结构：
   * “no server running”或 socket 缺失的 server 返回 `[]`（没有可连接客户端），使调用方给出
   * 诚实的“请先连接”错误而不是崩溃。意外失败（权限等）重新抛出。
   */
  async listClients(): Promise<TmuxClient[]> {
    try {
      const output = await this.exec(`tmux list-clients -F "${CLIENT_FORMAT}"`);
      return parseLines(output, parseClientLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  /**
   * OPR.0.4.3.26——将已连接客户端的视图重定向到 `target`
   *（`<session>` 或 `<session>:<window>`）。这是席位恢复 slice 的核心：只改变客户端看到的内容；
   * 绝不创建、终止或重新绑定 session，也不触碰 OpenRig 路由/身份。
   */
  async switchClient(client: string, target: string): Promise<TmuxResult> {
    const cmd = `tmux switch-client -c ${shellQuote(client)} -t ${shellQuote(target)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }
}
