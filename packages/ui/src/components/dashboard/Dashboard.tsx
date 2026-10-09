// OPR.0.4.1.14——仪表盘路由视觉刷新（创始人锁定的高保真孪生）。
//
// 仅刷新欢迎/主页启动器界面的视觉，不改变行为：同样六个目标仍路由到相同路径，全局
// AppShell 顶栏和左侧导航保持不变；孪生中“顶栏 + 侧栏保持原样”所指正是这套外壳。
// 大号数字的 vellum 卡片墙替换为锁定孪生中克制的纸稿式启动网格、现场环境读数和制图页脚
//（digital-twin/opr-0.4.1.14/dashboard-fidelity.intent.html），并采用创始人批准的现有代码图标集。
//
// 真实数据接线：现场环境中的每一行都读取实时运行状态
//（OPR.0.4.1.14 功能细化，无占位行）：
//   useRigSummary    → 工作组数量（真实，独占一行）
//   usePsEntries     → 智能体数量（真实，独占一行）
//   window.location.hostname → 站点 ID（真实）
//   useSettings(agents.operator_session) → 操作人员 ID；未设置时如实回退到“操作人员”。
//     这是当前最佳可用身份：系统没有逐用户身份，而 /api/whoami 需要浏览器无法提供的会话参数，
//     详见切片交接说明。
//   useDaemonVersion → 版本（通过 /api/health-summary/version 获取真实运行中后台服务版本，
//     不是 UI 包的构建时版本）。
// 已移除先前的会话占位行和装饰性磁偏角花饰，使卡片只显示真实运行时数据。

import "./dashboard-fidelity.css";

import { Link } from "@tanstack/react-router";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useSettings } from "../../hooks/useSettings.js";
import { useDaemonVersion } from "../../hooks/useDaemonVersion.js";
import { parseSessionName } from "../../lib/session-name.js";
import { KernelStatusCard } from "../KernelStatusCard.js";
import { HostConfigCard } from "./HostConfigCard.js";
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
import {
  TopologyGlyph,
  ProjectGlyph,
  ForYouGlyph,
  LibraryGlyph,
  SearchGlyph,
  SettingsGlyph,
  FieldGlobeGlyph,
  CaptionGlyph,
  type CaptionGlyphKind,
} from "./vellum/fidelity-glyphs.js";

interface Destination {
  num: string;
  to: string;
  label: string;
  caption: string;
  glyph: React.ReactNode;
  captionGlyph: CaptionGlyphKind;
  /** “为你推荐”是唯一使用琥珀强调色的说明文字。 */
  amber?: boolean;
}

// 路由与顺序相较旧仪表盘完全不变，不改变行为。
const DESTINATIONS: Destination[] = [
  { num: "01", to: "/topology", label: "拓扑", caption: "查看工作组图", glyph: <TopologyGlyph />, captionGlyph: "cross" },
  { num: "02", to: "/project", label: "项目", caption: "浏览项目", glyph: <ProjectGlyph />, captionGlyph: "square" },
  { num: "03", to: "/for-you", label: "为你", caption: "优先为你推荐", glyph: <ForYouGlyph />, captionGlyph: "square", amber: true },
  { num: "04", to: "/specs", label: "库", caption: "规格与产物", glyph: <LibraryGlyph />, captionGlyph: "cross" },
  { num: "05", to: "/search", label: "搜索与审计", caption: "查找与校验", glyph: <SearchGlyph />, captionGlyph: "circle" },
  { num: "06", to: "/settings", label: "设置", caption: "配置 · 状态", glyph: <SettingsGlyph />, captionGlyph: "circle" },
];

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, "0");
}

/** 从 useSettings 载荷读取字符串 ConfigStore 设置。 */
function readSetting(
  data: { settings?: Record<string, { value?: unknown }> } | undefined,
  key: string,
): string {
  const v = data?.settings?.[key]?.value;
  return typeof v === "string" ? v : "";
}

export function Dashboard() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries, isError: psError } = usePsEntries();
  const { data: settings } = useSettings();
  const { data: versionData } = useDaemonVersion();

  const totalRigs = rigs?.length ?? 0;
  const totalAgents = psEntries?.reduce((acc, p) => acc + p.nodeCount, 0) ?? 0;

  const hostname =
    typeof window === "undefined" ? "localhost" : window.location.hostname || "localhost";
  const station = hostname.toUpperCase();
  const online = !psError && psEntries !== undefined;

  // 操作人员身份来自已配置的操作席位（logicalId@rigId）；未设置时如实回退到“操作人员”，
  // 这是当前最佳真实来源。
  const operatorSession = readSetting(settings, "agents.operator_session");
  // OPR.0.4.6.MH1 FR-8：共享解析契约。
  const parsedOperator = parseSessionName(operatorSession);
  const operatorId =
    parsedOperator.kind === "canonical" ? parsedOperator.member.toUpperCase() : "操作者";

  // 运行中后台服务版本，通过 useDaemonVersion 获取真实值。查询加载中或获取失败时如实回退到
  // 长破折号；后台服务本身无法读取自身 package.json 时已经会返回 "unknown"。
  const version = (versionData?.version ?? "").toUpperCase() || "—";

  return (
    <div data-testid="dashboard-surface" className="df-root">
      <div className="df-main">
        <div className="df-head">
          <div className="df-eyebrow">
            <span className="df-eyebrow-l">
              <span className="df-gd" aria-hidden="true" />
              操作者
            </span>
            <span className="df-eyebrow-r">仪表盘 · 启动器 · 配置存储支持</span>
          </div>

          <h1 data-testid="dashboard-greeting" className="df-h1">
            欢迎回来，操作者。
          </h1>
          <div className="df-sub">
            站点 {station} 已 <b>[ {online ? "在线" : "连接中"} ]</b>
          </div>

          <FieldEnvironment
            station={station}
            operatorId={operatorId}
            rigs={totalRigs}
            agents={totalAgents}
            version={version}
          />
          <div className="df-reg" aria-hidden="true" />
        </div>

        {/* OPR.0.4.3.22 — kernel status FIRST (from /api/kernel/status, NEVER
            daemon /healthz), with a Restore-kernel recovery control. */}
        <section data-testid="dashboard-kernel-section" className="mb-6 max-w-md">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary mb-2">
            主机 / 内核
          </div>
          <ErrorBoundary label="内核状态">
            <KernelStatusCard />
          </ErrorBoundary>
        </section>

        {/* OPR.0.4.6.MH1 FR-5 —— host-config component (own host +
            added hosts + add affordance + switcher). */}
        <ErrorBoundary label="主机">
          <HostConfigCard />
        </ErrorBoundary>

        <div className="df-grid" data-testid="dashboard-launcher-grid">
          {DESTINATIONS.map((d) => (
            <LauncherCard key={d.num} dest={d} />
          ))}
        </div>
      </div>

      <DashboardFooter />
    </div>
  );
}

interface FieldEnvironmentProps {
  station: string;
  operatorId: string;
  rigs: number;
  agents: number;
  version: string;
}

function FieldEnvironment({
  station,
  operatorId,
  rigs,
  agents,
  version,
}: FieldEnvironmentProps) {
  // 每一行都是真实运行时数据（OPR.0.4.1.14）：移除会话占位行和装饰性磁偏角行；工作组与
  // 智能体分别独占一行显示实时数量；版本是运行中后台服务版本。复古等宽字体和点线引导样式不变。
  const rows: Array<{ k: string; v: string }> = [
    { k: "站点 ID", v: station },
    { k: "操作者 ID", v: operatorId },
    { k: "工作组", v: pad2(rigs) },
    { k: "智能体", v: pad2(agents) },
    { k: "版本", v: version },
  ];
  return (
    <section
      data-testid="dashboard-field-environment"
      className="df-fieldenv"
      aria-label="现场环境"
    >
      <div className="df-feh">
        <span>现场环境</span>
        <span className="df-feh-mark" aria-hidden="true" />
      </div>
      <div className="df-fe-body">
        <div className="df-fe-list">
          {rows.map((r) => (
            <div className="df-fe-row" key={r.k}>
              <span className="df-k">{r.k}</span>
              <span className="df-dots" aria-hidden="true" />
              <span className="df-v">{r.v}</span>
            </div>
          ))}
        </div>
        <div className="df-fe-globe" aria-hidden="true">
          <FieldGlobeGlyph />
        </div>
      </div>
    </section>
  );
}

function LauncherCard({ dest }: { dest: Destination }) {
  return (
    <div className="df-cell">
      <Link
        to={dest.to}
        data-testid={`dashboard-card-${dest.num}`}
        aria-label={dest.label}
        className="df-card"
      >
        <span className="df-plus" aria-hidden="true" />
        <span className="df-idx">
          {dest.num} <i className="df-idx-sq" aria-hidden="true" />
        </span>
        <span className="df-glyph" aria-hidden="true">
          {dest.glyph}
        </span>
        <span className="df-clabel">{dest.label}</span>
        <span className="df-half" aria-hidden="true" />
        <span className="df-crop" aria-hidden="true">
          <i className="df-crop-tl" />
          <i className="df-crop-br" />
        </span>
      </Link>
      <div className={`df-cap${dest.amber ? " df-cap--amber" : ""}`}>
        <span className="df-cap-glyph" aria-hidden="true">
          <CaptionGlyph kind={dest.captionGlyph} />
        </span>
        <span className="df-lead" aria-hidden="true" />
        {dest.caption}
      </div>
    </div>
  );
}

function DashboardFooter() {
  // 半随机制图“痕迹”：按锁定孪生采用固定散点，保持确定性，使界面在多次渲染间稳定。
  const arts: Array<{ left: number; top: number; w: number; h: number }> = [
    { left: 6, top: 14, w: 4, h: 1 },
    { left: 16, top: 9, w: 1, h: 1 },
    { left: 24, top: 16, w: 3, h: 1 },
    { left: 34, top: 6, w: 1, h: 1 },
    { left: 30, top: 13, w: 1, h: 1 },
    { left: 46, top: 11, w: 5, h: 1 },
    { left: 58, top: 7, w: 1, h: 1 },
    { left: 66, top: 15, w: 2, h: 1 },
    { left: 78, top: 10, w: 1, h: 1 },
    { left: 90, top: 13, w: 4, h: 1 },
  ];
  return (
    <div className="df-foot" data-testid="dashboard-footer">
      <div className="df-foot-fl">
        <span className="df-foot-sq" aria-hidden="true" />
        [ 日志 ] .0001 · 一个独立构建，年复一年，始终如一
      </div>
      <span className="df-plus2" aria-hidden="true" />
      <span className="df-foot-dots" aria-hidden="true" />
      <div className="df-dissolve" aria-hidden="true">
        <span className="df-dissolve-blk" />
      </div>
      <div className="df-arts" aria-hidden="true">
        {arts.map((a, i) => (
          <i
            key={i}
            style={{ left: `${a.left}px`, top: `${a.top}px`, width: `${a.w}px`, height: `${a.h}px` }}
          />
        ))}
      </div>
      <div className="df-sqs" aria-hidden="true">
        <span className="df-sq-o" />
        <span className="df-sq-b" />
      </div>
      <span className="df-plus2" aria-hidden="true" />
    </div>
  );
}
