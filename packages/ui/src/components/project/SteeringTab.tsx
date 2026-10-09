// OPR.0.4.1.17 —— 任务 Steering 标签页（任务落地页）。两个堆叠的只读投影，
// 自上而下：面板 1 = 实时 STEERING.md 指令（智能体当前被告知做什么，
// 可追溯到来源），通过 GET /api/steering；面板 2 = 面向人类的简报
//（MISSION_BRIEF.md，投影到 slice-16 固定 schema）。它只读不写；
// 不引入新写入路径，不引入新 STEERING 源契约。

import type { ReactNode } from "react";
import {
  useSteering,
  type SteeringPayload,
  type SteeringUnavailable,
} from "../../hooks/useSteering.js";
import { useMission } from "../../hooks/useMission.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { useHostSelection, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";

function isUnavailable(
  data: SteeringPayload | SteeringUnavailable | undefined,
): data is SteeringUnavailable {
  return Boolean(data && "unavailable" in data);
}

// --- 面板 1：STEERING.md 投影 (GET /api/steering) ------------------------------
function SteeringPanel() {
  const { data, isLoading, error } = useSteering();

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div data-testid="steering-panel-loading" className="font-mono text-[11px] text-on-surface-variant">
        加载中…
      </div>
    );
  } else if (error) {
    body = (
      <EmptyState
        label="STEERING 不可用"
        description={(error as Error)?.message ?? "无法加载 /api/steering。"}
        variant="card"
        testId="steering-panel-error"
      />
    );
  } else if (isUnavailable(data)) {
    // 后台服务的 steering_workspace_not_configured 503 以此哨兵呈现。
    body = (
      <div data-testid="steering-panel-unavailable">
        <EmptyState
          label="未配置 STEERING"
          description={
            data.hint ??
            "将 workspace.steering_path 设置为 STEERING.md，实时指令将投影到此。"
          }
          variant="card"
          testId="steering-panel-unavailable-state"
        />
      </div>
    );
  } else if (data?.priorityStack) {
    const ps = data.priorityStack;
    body = (
      <>
        <div data-testid="steering-panel-content" className="mt-1">
          <MarkdownViewer content={ps.content} hideFrontmatter hideRawToggle />
        </div>
        {/* 离意图 → 可追溯到来源：实时指令 + 其位置。 */}
        <div data-testid="steering-panel-source" className="mt-2 font-mono text-[10px] text-on-surface-variant">
          来源：{ps.absolutePath} · 更新于 {new Date(ps.mtime).toLocaleString()}
        </div>
      </>
    );
  } else {
    body = (
      <EmptyState
        label="尚无 STEERING.md"
        description="配置的 workspace.steering_path 处无 STEERING.md 内容。实时指令一旦存在即投影到此。"
        variant="card"
        testId="steering-panel-empty"
      />
    );
  }

  return (
    <section data-testid="steering-panel" className="border border-outline-variant bg-surface-lowest/30 p-4">
      <SectionHeader>引导 · STEERING.md</SectionHeader>
      {body}
    </section>
  );
}

// --- 面板 2：MISSION_BRIEF.md 投影（slice-16 固定契约）-------------------
// 字节精确的规范标题 + 顺序。脚手架、填充 SOP 和此投影器都复制这些字符串——
// 绝不重新推导（不匹配 = 简报静默不渲染）。
const BRIEF_SECTIONS = ["What & why", "Building", "Progress", "Proven", "Needs you", "Pointers"];

interface ParsedBrief {
  title: string | null;
  tldr: string | null;
  sections: { header: string; body: string }[];
}

/** 将 MISSION_BRIEF.md 拆分为前导 `#` 标题（+ 可选斜体 TL;DR）和文档顺序的
 *  `##` 节。未知节保留（绝不丢弃）。 */
function parseBrief(markdown: string): ParsedBrief {
  let title: string | null = null;
  let tldr: string | null = null;
  const sections: { header: string; body: string[] }[] = [];
  let current: { header: string; body: string[] } | null = null;
  let sawTitle = false;

  for (const line of markdown.split("\n")) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h2) {
      current = { header: h2[1]!.trim(), body: [] };
      sections.push(current);
    } else if (h1 && !sawTitle && !current) {
      title = h1[1]!.trim();
      sawTitle = true;
    } else if (current) {
      current.body.push(line);
    } else if (sawTitle && tldr === null && line.trim().length > 0) {
      tldr = line.trim();
    }
  }
  return {
    title,
    tldr,
    sections: sections.map((s) => ({ header: s.header, body: s.body.join("\n").trim() })),
  };
}

function BriefSectionBlock({ header, body }: { header: string; body: string | undefined }) {
  return (
    <div data-testid={`brief-section-${header}`} className="border-t border-outline-variant/60 py-2">
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-on-surface">{header}</div>
      {body && body.length > 0 ? (
        <div className="mt-1">
          <MarkdownViewer content={body} hideFrontmatter hideRawToggle />
        </div>
      ) : (
        // 缺失或空的规范节 → 静音短横线（降级为短横线；显示预期形状 + 告诉填充者填什么）。
        <div data-testid={`brief-section-${header}-dash`} className="mt-1 font-mono text-[12px] text-on-surface-variant">
          —
        </div>
      )}
    </div>
  );
}

function BriefPanel({ missionId }: { missionId: string | null }) {
  const mission = useMission(missionId ?? "");
  // OPR.0.4.6.MH2 guard-B1 —— useMission 是选定主机重定向的，
  // 因此在远端选择下 missionPath 是远端路径：它绝不能对照本地白名单根目录
  // 解析（零 /api/files/* + 诚实复制）。
  const { known: selectionKnown, isLocal } = useHostSelection();
  const filesAllowed = useLocalFilesAllowed();
  const missionPath =
    filesAllowed && mission.data && "missionPath" in mission.data ? mission.data.missionPath : null;
  const brief = useScopeMarkdown(missionPath, "MISSION_BRIEF.md");

  let body: ReactNode;
  if (selectionKnown && !isLocal) {
    // 已知远端仅此——未知选择渲染下方的加载分支
    //（获取始终门控；无误导性门控闪烁）。
    body = (
      <div data-testid="brief-panel-remote-gated">
        <EmptyState
          label="不显示本地文件"
          description="任务简报位于所选主机的文件系统上，远端只读视图不浏览该系统。选择本地主机以读取本地简报。"
          variant="card"
          testId="brief-panel-remote-gated-state"
        />
      </div>
    );
  } else if (!selectionKnown || mission.isLoading || brief.isLoading) {
    body = (
      <div data-testid="brief-panel-loading" className="font-mono text-[11px] text-on-surface-variant">
        加载中…
      </div>
    );
  } else if (brief.state === "read_error") {
    // R1（release-0.4.7）：读取失败不是简报缺失。
    body = (
      <div data-testid="brief-panel-read-error">
        <EmptyState
          label="简报读取失败"
          description="后台服务无法读取 MISSION_BRIEF.md——这是读取失败，不是简报缺失。检查后台服务日志和文件权限。"
          variant="card"
          testId="brief-panel-read-error-state"
        />
      </div>
    );
  } else if (brief.state === "unresolved") {
    // R1：任务路径在白名单文件根目录（配置）之外，不是简报缺失。
    body = (
      <div data-testid="brief-panel-unresolved">
        <EmptyState
          label="简报在文件根目录之外"
          description="任务路径不在任何白名单文件根目录下，因此无法读取 MISSION_BRIEF.md。检查 OPENRIG_FILES_ALLOWLIST / 后台服务的文件根目录设置。"
          variant="card"
          testId="brief-panel-unresolved-state"
        />
      </div>
    );
  } else if (brief.unavailable || brief.content === null) {
    body = (
      <div data-testid="brief-panel-empty">
        <EmptyState
          label="尚无简报"
          description="任务根目录下无 MISSION_BRIEF.md。面向人类的简报（我们在构建什么 · 进展如何 · 已验证什么 · 需要你做什么）在任务简报后投影到此。"
          variant="card"
          testId="brief-panel-empty-state"
        />
      </div>
    );
  } else {
    const parsed = parseBrief(brief.content);
    const knownSet = new Set(BRIEF_SECTIONS);
    const bodyByHeader = new Map(parsed.sections.map((s) => [s.header, s.body]));
    const extras = parsed.sections.filter((s) => !knownSet.has(s.header));
    body = (
      <div data-testid="brief-panel-content">
        {parsed.title && (
          <div className="font-mono text-[13px] uppercase tracking-[0.08em] text-on-surface">{parsed.title}</div>
        )}
        {parsed.tldr && <p className="mt-0.5 text-[12px] italic text-on-surface-variant">{parsed.tldr}</p>}
        {/* 规范节，按契约顺序，按精确标题匹配。 */}
        {BRIEF_SECTIONS.map((header) => (
          <BriefSectionBlock key={header} header={header} body={bodyByHeader.get(header)} />
        ))}
        {/* 未知/额外节在已知节后渲染，按文档顺序——绝不丢弃。 */}
        {extras.map((s, i) => (
          <BriefSectionBlock key={`extra-${i}-${s.header}`} header={s.header} body={s.body} />
        ))}
      </div>
    );
  }

  return (
    <section data-testid="brief-panel" className="border border-outline-variant bg-surface-lowest/20 p-4">
      <SectionHeader>简报 · 面向人类</SectionHeader>
      {body}
    </section>
  );
}

export function SteeringTab({ missionId }: { missionId: string | null }) {
  return (
    <div data-testid="steering-tab" className="space-y-6">
      <SteeringPanel />
      <BriefPanel missionId={missionId} />
    </div>
  );
}
