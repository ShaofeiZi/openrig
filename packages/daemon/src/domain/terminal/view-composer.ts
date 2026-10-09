// OPR.0.4.6.02 C2——纯视图组合器。
//
// 把已解析的视图成员列表转换为 provider 无关的 `ComposedView`
//（`{ opened, absent, degraded, pages }`，BR-6 如实部分结果）。所有分区规则均集中在这个
// 可测试的纯函数中，避免各 provider 重复实现：
//
//   本地活跃成员                         → `tmux attach -t <session>`
//   只读视图 / 跨工作组成员（只读）       → `tmux attach -r -t <session>`
//   ssh 主机                            → `ssh <dest> tmux attach [-r] -t <session>`
//   http 主机                           → 不创建窗格；如实降级 { seat, host, reason }
//   已停止 / 无会话                     → absent[]（明确记录，绝不静默丢弃）
//
// 组合器接收已携带结构化 `host` 字段的成员（主机 id，绝不是
// `member@rig@host` 字符串——MH BR-1）。主机分类（ssh、http 或 unknown）
// 通过注入的 `resolveHost`，从操作员的只读主机注册表解析。

import type { HostEntry } from "../hosts/hosts-registry-reader.js";
import type {
  AbsentSeat,
  ComposedPane,
  ComposedView,
  DegradedSeat,
} from "./terminal-provider.js";

/**
 * 每个网格页的默认窗格数为 9（3×3），用于 provider 未声明自身页面大小时（cmux）。
 * Herdr 声明 16（4×4）；溢出项进入下一个 provider 标签页/页面。未来逐工作组的
 * `terminal.tiles_per_page` 配置 key 是布局选择的自然接缝；此处不交付配置 key。
 */
export const PANES_PER_PAGE = 9;

/**
 * 一个已解析、可供组合的视图成员。`alive` 与 `readOnly` 由上游决定
 *（存活探测 + 跨工作组/已保存只读策略），组合器只据此路由。`host` 是结构化主机 id，
 * 本地成员则为 null。
 */
export interface ViewMemberInput {
  /** 席位的规范会话名称。 */
  seat: string;
  /** 窗格标签：`<agent> · <slice>`（AC-7）。 */
  label: string;
  /** 要附着的 tmux 会话；席位没有 tmux 绑定时可为 null。 */
  tmuxSession: string | null;
  /** 远程席位使用结构化主机 id；本地席位为 null。 */
  host: string | null;
  /** 只读视图 / 跨工作组成员 → 使用只读（`-r`）附着。 */
  readOnly: boolean;
  /** 本地存活性（has-session）；远程成员忽略该值，其可达性由 ssh 负责。 */
  alive: boolean;
}

/** 组合器唯一的旁路：从注册表只读解析主机。 */
export interface ComposeContext {
  /** 把主机 id 解析为注册表条目；id 未知时返回 null。 */
  resolveHost(id: string): HostEntry | null;
  /** 目标 provider 的每页窗格数；默认为 PANES_PER_PAGE。 */
  panesPerPage?: number;
}

/** 使用 POSIX 单引号引用字符串，使组合命令中的会话名称/目标不产生 shell 语义。 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** 远程 ssh 目标：声明 user 时为 `user@target`，否则为 `target`。 */
function sshDest(host: Extract<HostEntry, { transport: "ssh" }>): string {
  return host.user ? `${host.user}@${host.target}` : host.target;
}

/** 把窗格分割为固定大小的网格页，每页对应一个 provider 标签页。 */
export function chunkPanes(
  panes: ComposedPane[],
  perPage: number = PANES_PER_PAGE,
): ComposedPane[][] {
  if (perPage < 1) throw new Error(`chunkPanes：perPage 必须 >= 1（收到 ${perPage}）`);
  const pages: ComposedPane[][] = [];
  for (let i = 0; i < panes.length; i += perPage) {
    pages.push(panes.slice(i, i + perPage));
  }
  return pages;
}

/**
 * 把已解析成员列表组合成 provider 无关视图。此函数为纯函数：相同输入产生逐字节相同输出。
 * 成员顺序会保留到 `opened`（进而保留到页面分配），因此分页是确定性的。
 */
export function composeView(
  id: string,
  members: ViewMemberInput[],
  ctx: ComposeContext,
): ComposedView {
  const opened: ComposedPane[] = [];
  const absent: AbsentSeat[] = [];
  const degraded: DegradedSeat[] = [];

  for (const m of members) {
    const attachFlag = m.readOnly ? "-r " : "";

    if (m.host !== null) {
      // 远程成员：按注册表条目的 transport 分类。
      const host = ctx.resolveHost(m.host);
      if (!host) {
        // 未知主机 id 是配置缺口，不是活跃席位；明确降级，绝不静默省略。
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `主机 ${m.host} 不在主机注册表中`,
        });
        continue;
      }
      if (host.transport === "http") {
        // http 主机使用后台服务 REST，而非交互式 ssh 窗格；磁贴表面需要 ssh。
        // 按 R1(a) 如实降级。
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `主机 ${m.host} 以 HTTP 注册；终端磁贴需要 SSH`,
        });
        continue;
      }
      // ssh 主机：未记录 tmux 会话的席位无法附着。
      if (!m.tmuxSession) {
        absent.push({
          seat: m.seat,
          host: m.host,
          reason: "未记录此席位的 tmux 会话",
        });
        continue;
      }
      // 守卫 G1：主机注册表是结构化数据，但窗格命令是 shell 字符串，因此 ssh 目标必须不产生
      // shell 语义，也不能形似选项。否则，带空格或 shell 元字符的注册表 `user`/`target`
      // 会拆成额外 shell 参数；前导 `-` 会被 ssh 解析为选项，造成选项注入。
      // 对目标执行 shell 引用，使其严格保持一个参数；以 `-` 开头的目标则明确降级
      //（指出原因且绝不执行）。
      const dest = sshDest(host);
      if (dest.startsWith("-")) {
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `主机 ${m.host} 的 SSH 目标 '${dest}' 形似选项（以 '-' 开头）；拒绝组合 SSH 磁贴`,
        });
        continue;
      }
      opened.push({
        seat: m.seat,
        label: m.label,
        paneCommand: `ssh ${shellQuote(dest)} tmux attach ${attachFlag}-t ${shellQuote(m.tmuxSession)}`,
        readOnly: m.readOnly,
      });
      continue;
    }

    // 本地成员。
    if (!m.tmuxSession) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: "未记录此席位的 tmux 会话",
      });
      continue;
    }
    if (!m.alive) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: `tmux 会话 ${m.tmuxSession} 未存活`,
      });
      continue;
    }
    opened.push({
      seat: m.seat,
      label: m.label,
      paneCommand: `tmux attach ${attachFlag}-t ${shellQuote(m.tmuxSession)}`,
      readOnly: m.readOnly,
    });
  }

  return { id, opened, absent, degraded, pages: chunkPanes(opened, ctx.panesPerPage ?? PANES_PER_PAGE) };
}
