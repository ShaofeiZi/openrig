// Slice-17 mini-req 1——方向-B 文件树导航器重皮肤。
//
// 对单行模型的纯展示变换：computeExplorerRows
// 保持行/键/动作的唯一来源（PIN-1——reducer 的
// 'activate' 和渲染器的命中图继续对照它解析）；此
// 模块仅派生每行的显示标签：
//   · 从行的键深度连续分支引导线 │ ├─ └─，
//   · 图标：主机 ⊕ · 工作组 ▦（round-3 创建者记录选择）· 席位置 ≡（置灰
//     名称 + 真正的 ▾/▸）· 智能体状态字形通过 rowStatusGlyph，
//   · 元数据右对齐（智能体 ctx% —— 为 null 时诚实 `—`；席位数），
//   · 仅在折叠真正存在的地方折叠字形（席位和规格
//     文件夹）——主机/工作组/分区携带装饰性 ▾ 但
//     不提供任何功能；它被丢弃，而非重皮肤（无虚假可用性）。
// "悬停"是现有选择焦点高亮——仅渲染，无动效
// 协议，无选择的第二写入路径（arch 裁决 1）。
import type { AgentRow, ExplorerRow, FleetSnapshot } from "./types.js";
import type { MarkSeg } from "./topology/runtime-marks.js";
import { rowStatusGlyph } from "./topology/glyphs.js";

interface KeyParts {
  kind: string;
  parts: string[];
}

function parseKey(key: string | undefined): KeyParts | null {
  if (!key) return null;
  const at = key.indexOf(":");
  if (at < 0) return null;
  return { kind: key.slice(0, at), parts: key.slice(at + 1).split("/") };
}

function keyDepth(row: ExplorerRow): number {
  const parsed = parseKey(row.key);
  if (!parsed) return -1; // 无键行（过滤器、needs 项）保持其标签
  switch (parsed.kind) {
    case "section":
      return 0;
    case "host":
    case "specs-kind":
    case "scopes-mission":
      return 1;
    case "rig":
    case "folder":
    case "scopes-slice":
      return 2;
    case "pod":
      return 3;
    case "spec":
      // 行模型的规格键不携带父关系（防护发现 2）；
      // 文件夹成员身份确实编码在已发布标签缩进中——
      // 有文件夹规格缩进 6 空格，根规格 4（state.ts）——因此
      // 子级渲染在其文件夹下方一级，绝非兄弟。
      return /^ {6}/.test(row.label) ? 3 : 2;
    case "agent":
      return 4;
    default:
      return -1;
  }
}

/** 剥离了遗留缩进 + 列表字形的标签；席位/文件夹行
 *  保持其真正的 ▾/▸（它们真正折叠），主机/工作组失去它们 */
function contentOf(row: ExplorerRow, parsed: KeyParts, snap: FleetSnapshot): string {
  const stripped = row.label.replace(/^\s+/, "");
  if (parsed.kind === "host") return `⊕ ${stripped.replace(/^[▾⌄] /, "")}`;
  if (parsed.kind === "rig") return `${rigPresence(parsed, snap) === null ? "?" : "▦"} ${stripped.replace(/^[▾⌄] /, "")}`;
  if (parsed.kind === "pod") return stripped.replace(/^[▾▸] /, (m) => m.startsWith("▾") ? "⌄ " : "› ").replace(/ \(\d+\)$/, ""); // 计数移到元数据
  if (parsed.kind === "scopes-mission") return stripped.replace(/^[▾▸] /, (m) => m.startsWith("▾") ? "⌄ " : "› ");
  if (parsed.kind === "agent") {
    // 席位相对显示（防护裁决；导航流 mockup 的约定——
    // "driver" 在席位 dev50 下）：仅剥离确认的 `${pod}.` 前缀，使
    // 同席位兄弟在固定窗格宽度下保持可见区分；任何
    // 无前缀的服务名称不变显示（诚实回退）。完整
    // 服务身份始终存在于行键/动作/选择/详情中。
    const pod = parsed.parts[2];
    const name = parsed.parts.slice(3).join("/");
    const display = pod && name.startsWith(`${pod}.`) ? name.slice(pod.length + 1) : name;
    return stripped.replace(name, display);
  }
  return stripped;
}

export interface NavigatorMeta {
  /** 此运行开始的列（在显示标签内） */
  start: number;
  /** token 段——运行自己的颜色（状态角色；以前是标记的
   *  bg 通道）通过此通道在绘制层中存活（防护发现 2；
   *  round-4：行可能携带多个运行——状态徽章 + 右元数据） */
  segs: MarkSeg[];
}

function agentOf(parsed: KeyParts, snap: FleetSnapshot): AgentRow | null {
  const [host, rig, pod, ...name] = parsed.parts;
  return snap.hosts
    .find((h) => h.name === host)?.rigs.find((r) => r.name === rig)
    ?.pods.find((p) => p.name === pod)?.agents.find((a) => a.name === name.join("/")) ?? null;
}

/** 使用结构化身份/存在性，绝不可能被裁剪的状态后缀。 */
function rigPresence(parsed: KeyParts, snap: FleetSnapshot): boolean | null {
  const host = snap.hosts.find(h => h.name === parsed.parts[0]);
  if (!host?.reachable) return null;
  return host.rigs.find(r => r.name === parsed.parts[1])?.hasLiveAgents ?? null;
}

function metaOf(row: ExplorerRow, snap: FleetSnapshot): { text: string; segs: MarkSeg[] } | null {
  const parsed = parseKey(row.key);
  if (!parsed) return null;
  if (parsed.kind === "agent") {
    const agent = agentOf(parsed, snap);
    if (!agent) return null;
    // ROUND-3 LOCKED：运行时标记在资源管理器行上关闭（详情 + 拓扑
    // 仅；堆叠行太繁忙）——元数据是裸 ctx%，未知时诚实；
    // 拼写运行时保持死；名称优先不截断保持。
    const value = agent.context == null ? "—" : `${agent.context}%`;
    return { text: value, segs: [{ text: value, token: "dim" }] };
  }
  if (parsed.kind === "pod") {
    const [host, rig, pod] = parsed.parts;
    const found = snap.hosts.find((h) => h.name === host)?.rigs.find((r) => r.name === rig)?.pods.find((p) => p.name === pod);
    return found ? { text: String(found.agents.length), segs: [{ text: String(found.agents.length), token: "dim" }] } : null;
  }
  return null;
}

/**
 * 资源管理器窗格的显示行——标签 + 段运行通道
 * （与 `rows` 顺序/长度相同；每行携带 0..n 绘制运行）。
 */
export function navigatorDisplay(
  rows: ExplorerRow[],
  snap: FleetSnapshot,
  width: number,
): { labels: string[]; metas: Array<NavigatorMeta[] | null> } {
  const metas: Array<NavigatorMeta[] | null> = [];
  const labels = navigatorLabelsInner(rows, snap, width, metas);
  return { labels, metas };
}

/** 兼容视图（仅需要标签的测试/调用方） */
export function navigatorLabels(rows: ExplorerRow[], snap: FleetSnapshot, width: number): string[] {
  return navigatorDisplay(rows, snap, width).labels;
}

function navigatorLabelsInner(rows: ExplorerRow[], snap: FleetSnapshot, width: number, metasOut: Array<NavigatorMeta[] | null>): string[] {
  const depths = rows.map((row) => keyDepth(row));
  const isLast = rows.map((_, i) => {
    const depth = depths[i]!;
    if (depth <= 0) return true;
    for (let j = i + 1; j < rows.length; j++) {
      const other = depths[j]!;
      if (other < 0) continue;
      if (other < depth) return true;
      if (other === depth) return false;
    }
    return true;
  });

  // 延续轨是 mockup 的字面 │（防护发现 4，锁定
  // 字形）。窗格边框也是 │ 但位于固定列（EXPL_W）——
  // 绘制层和地板通过该边界定位它，绝不通过扫描
  // 第一个 │（轨会遮蔽它）。
  const railOpen: boolean[] = []; // 每个深度级别：后面有兄弟吗？
  return rows.map((row, i) => {
    const depth = depths[i]!;
    if (depth < 0) { metasOut.push(null); return row.label; } // 无键行不动
    if (depth === 0) {
      metasOut.push(null);
      return row.label;
    }
    railOpen[depth] = !isLast[i]!;
    const guides = Array.from({ length: depth - 1 }, (_, level) => (railOpen[level + 1] ? "┃ " : "  ")).join("");
    const branch = isLast[i] ? "┗━ " : "┣━ ";
    const parsed = parseKey(row.key)!;
    const content = contentOf(row, parsed, snap);
    const meta = metaOf(row, snap);
    const prefix = ` ${guides}${branch}`;
    // S19 round-4（防护发现 4）：智能体行携带状态徽章运行，使
    // 服务真字形绘制其活动角色（颜色用于状态——
    // 行上唯一的彩色东西；非状态图标保持单色）
    const runs: NavigatorMeta[] = [];
    if (parsed.kind === "rig") {
      const live = rigPresence(parsed, snap);
      runs.push({ start: prefix.length, segs: [{ text: live === null ? "?" : "▦", token: live === true ? "bright" : "dim" }] });
    }
    if (parsed.kind === "agent") {
      const agent = agentOf(parsed, snap);
      if (agent) {
        const st = rowStatusGlyph(agent);
        runs.push({ start: prefix.length, segs: [{ text: st.glyph, token: st.token }] });
      }
    }
    if (!meta) { metasOut.push(runs.length ? runs : null); return `${prefix}${content}`; }
    // S19 重新封印宽度策略（防护 NOT-CLEAR 发现 1）：名称渲染
    // 第一且不截断——当全名不留空间时，元数据
    // 完全让步（绝不省略号化的身份）。
    const room = width - prefix.length - content.length - 1;
    if (room < meta.text.length) { metasOut.push(runs.length ? runs : null); return `${prefix}${content}`; }
    const gap = Math.max(width - prefix.length - content.length - meta.text.length, 1);
    runs.push({ start: prefix.length + content.length + gap, segs: meta.segs });
    metasOut.push(runs);
    return `${prefix}${content}${" ".repeat(gap)}${meta.text}`;
  });
}
