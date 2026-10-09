// OPR.0.4.6.02 C2 —— 终端视图存储。
//
// SAVED 视图持久化在 OPENRIG_HOME 根目录的 `terminal-views.yaml` 中（可通过
// OPENRIG_HOME 实现 VM 隔离）。它们写入后在启动时读取：后台服务启动时加载，
// 操作员保存的布局可跨重启保留。每个已保存成员都携带结构化 `host` 字段
// （主机 ID，绝不是 `member@rig@host` 字符串——MH BR-1）。
//
// DERIVED 视图（按工作组/任务目标/切片）由实时席位清单和审查智能体带即时计算，
// 绝不写入磁盘（A3）。该不变量由结构保证，而非仅靠约定：本模块暴露纯映射器
// `deriveViewMembers`，而 `save()` 只接受 `SavedView`，不存在持久化派生视图的路径。
//
// 写入是原子的（同一文件系统内临时文件加 rename）且字节稳定：序列化使用固定字段
// 顺序，并省略缺失的可选字段（绝不写 null），因此同一逻辑内容的读取→保存往返幂等。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import type { ViewMemberInput } from "./view-composer.js";

  /** 已保存视图中的一个持久化成员；写入时省略缺失的可选字段。 */
export interface SavedViewMember {
  /** 席位的规范会话名。 */
  seat: string;
  /** Pane 标签——`<agent> · <slice>`。 */
  label?: string;
  /** 结构化主机 ID（绝不是 `member@rig@host` 字符串）；本地席位省略。 */
  host?: string;
  /** 要附加的 tmux 会话。 */
  tmuxSession?: string;
  /** 仅查看/只读附加；非只读时省略（默认为 false）。 */
  readOnly?: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  members: SavedViewMember[];
}

export interface TerminalViewsFile {
  version: 1;
  views: SavedView[];
}

const EMPTY_FILE: TerminalViewsFile = { version: 1, views: [] };

  /** 按固定键顺序构造成员对象，省略缺失的可选字段（绝不写 null）。 */
function normalizeMember(m: SavedViewMember): SavedViewMember {
  const out: SavedViewMember = { seat: m.seat };
  if (m.label != null && m.label !== "") out.label = m.label;
  if (m.host != null && m.host !== "") out.host = m.host;
  if (m.tmuxSession != null && m.tmuxSession !== "") out.tmuxSession = m.tmuxSession;
  if (m.readOnly === true) out.readOnly = true;
  return out;
}

function normalizeView(v: SavedView): SavedView {
  return { id: v.id, name: v.name, members: v.members.map(normalizeMember) };
}

  /** 整个文件的规范、字节稳定序列化（固定顺序，缺失即省略）。 */
function serialize(file: TerminalViewsFile): string {
  const normalized: TerminalViewsFile = {
    version: 1,
    views: file.views.map(normalizeView),
  };
  return stringifyYaml(normalized);
}

export class TerminalViewsStore {
  constructor(private readonly path: string = getDefaultOpenRigPath("terminal-views.yaml")) {}

  /** 解析后的磁盘路径（供测试/诊断使用）。 */
  getPath(): string {
    return this.path;
  }

  /**
   * 启动时读取。文件缺失时返回空集合；格式错误时抛出异常（如实报告，绝不静默
   * 重置并丢弃操作员布局）。
   */
  read(): TerminalViewsFile {
    if (!existsSync(this.path)) return { version: 1, views: [] };
    const raw = readFileSync(this.path, "utf-8");
    const parsed = parseYaml(raw) as unknown;
    if (parsed == null) return { version: 1, views: [] };
    if (typeof parsed !== "object") {
      throw new Error(`${this.path} 处的终端视图文件必须是包含“views”数组的 YAML 对象`);
    }
    const obj = parsed as Record<string, unknown>;
    const views = obj["views"];
    if (!Array.isArray(views)) {
      throw new Error(`${this.path} 处的终端视图文件：“views”必须是数组`);
    }
    return { version: 1, views: views as SavedView[] };
  }

  list(): SavedView[] {
    return this.read().views;
  }

  get(id: string): SavedView | null {
    return this.read().views.find((v) => v.id === id) ?? null;
  }

  /**
   * 持久化 SAVED 视图（按 ID upsert）。写入原子且字节稳定，并返回最终文件。
   * 只接受 `SavedView`，派生视图绝不可能通过此路径写入磁盘（A3）。
   */
  save(view: SavedView): TerminalViewsFile {
    const current = this.read();
    const idx = current.views.findIndex((v) => v.id === view.id);
    const next: SavedView[] = [...current.views];
    if (idx >= 0) next[idx] = view;
    else next.push(view);
    const file: TerminalViewsFile = { version: 1, views: next };
    this.writeAtomic(file);
    return { version: 1, views: file.views.map(normalizeView) };
  }

  /** 按 ID 删除已保存视图（幂等），操作为原子写入。 */
  remove(id: string): TerminalViewsFile {
    const current = this.read();
    const file: TerminalViewsFile = {
      version: 1,
      views: current.views.filter((v) => v.id !== id),
    };
    this.writeAtomic(file);
    return { version: 1, views: file.views.map(normalizeView) };
  }

  private writeAtomic(file: TerminalViewsFile): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, serialize(file), "utf-8");
    renameSync(tmp, this.path);
  }
}

// --- 派生视图（实时计算，绝不持久化——A3）---

/**
 * 派生视图映射器所需的实时席位记录最小结构。刻意使用子集而不导入
 * `NodeInventoryEntry`，使本模块不依赖清单的传递依赖且易于测试。字段名与
 * `NodeInventoryEntry` 一致。
 */
export interface LiveSeatRow {
  canonicalSessionName: string | null;
  /** tmux 承载的席位为 "tmux"；其他类型没有可附加 pane。 */
  attachmentType: string | null;
  /** tmux 会话名（tmux 承载席位的规范会话名）。 */
  tmuxSession?: string | null;
  rigName?: string | null;
  logicalId?: string | null;
}

/** 控制派生视图如何标注成员及限定其范围的选项。 */
export interface DeriveOptions {
  /** 写入每个派生成员的结构化主机 ID（远程范围）；本地时省略。 */
  host?: string | null;
  /** 为 true 时，成员以只读方式（`-r`）附加，用于跨工作组/仅查看的派生范围。 */
  readOnly?: boolean;
  /** pane 标签的切片/任务目标后缀（`<agent> · <slice>`），可选。 */
  labelSuffix?: string;
}

/**
 * 将实时席位清单映射为可供 composer 使用的成员。该操作纯净且只在内存中执行；
 * 结果直接交给 `composeView`，绝不写入 saved-views 文件。非 tmux 或无会话记录
 * 会从派生集合中移除（派生视图只平铺可附加席位；已保存视图可以指向缺席项）。
 */
export function deriveViewMembers(
  rows: LiveSeatRow[],
  opts: DeriveOptions = {},
): ViewMemberInput[] {
  const members: ViewMemberInput[] = [];
  for (const row of rows) {
    if (row.attachmentType !== "tmux") continue;
    const seat = row.canonicalSessionName;
    if (!seat) continue;
    const tmuxSession = row.tmuxSession ?? row.canonicalSessionName;
    const agent = row.logicalId ?? seat;
    const label = opts.labelSuffix ? `${agent} · ${opts.labelSuffix}` : agent;
    members.push({
      seat,
      label,
      tmuxSession,
      host: opts.host ?? null,
      readOnly: opts.readOnly === true,
  // 派生视图是实时的：出现在清单中本身就是派生集合的存活信号；若调用方提供，
  // 本地成员在 compose 时可叠加更严格的会话存在性探测。
      alive: true,
    });
  }
  return members;
}
