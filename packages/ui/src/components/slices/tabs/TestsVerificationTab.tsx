// 切片故事视图 v0——测试/验证页签。
//
// 关键能力：证明包携带截图和视频时，行内显示截图并提供可用的 <video> 播放器。
//
// 按 PRD 审计第 6 行修订，真实证明包布局不同于原 PRD 提案：目录形如
// `dogfood-evidence/<prefix>-<slice>-<date>/`，顶层为 `*.md`，另含 `screenshots/*.png`
// 和可选的 `headed-browser/screenshots/`。QA 尚未捕获视频；页签会优雅处理，videos 数组为空时
// 不渲染 <video> 元素，也不报错。
//
// 聚合通过/失败徽标位于标题中，反映从主 Markdown 启发式提取的结果。真正的规范答案位于
// 行内渲染的 Markdown 正文中。

import { useState } from "react";
import type { SliceDetail, ProofPacketRendered } from "../../../hooks/useSlices.js";
import { proofAssetUrl } from "../../../hooks/useSlices.js";
import { ToolMark } from "../../graphics/RuntimeMark.js";
import { ProofPacketHeader } from "../../project/ProjectMetaPrimitives.js";
import { ProofImageViewer } from "../../project/ProofImageViewer.js";

const BADGE_TEST_TONE_CLASSES: Record<ProofPacketRendered["passFailBadge"], string> = {
  pass: "text-emerald-900",
  fail: "text-red-900",
  partial: "text-amber-900",
  unknown: "text-on-surface",
};

export function TestsVerificationTab({
  sliceName,
  tests,
  qitemCount,
  docsCount,
  lastActivityAt,
}: {
  sliceName: string;
  tests: SliceDetail["tests"];
  qitemCount?: number;
  docsCount?: number;
  lastActivityAt?: string | null;
}) {
  if (tests.proofPackets.length === 0) {
    return (
      <div
        className="border border-outline-variant bg-surface-lowest/20 p-4 font-mono"
        data-testid="tests-empty"
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
          未匹配到校验包
        </div>
        <p
          data-testid="tests-empty-reason"
          className="mt-2 max-w-2xl text-[11px] leading-relaxed text-on-surface"
        >
          校验匹配器未找到名称包含此切片 id 的 dogfood 证据目录。证据仍可能存在于
          已配置的证据根或相关任务文件夹下。
        </p>
        <div
          data-testid="tests-empty-diagnostics"
          className="mt-3 grid gap-2 text-[10px] text-on-surface-variant sm:grid-cols-3"
        >
          <Metric label="队列项" value={qitemCount ?? 0} />
          <Metric label="已索引文件" value={docsCount ?? 0} />
          <Metric label="最近活动" value={formatMaybeDate(lastActivityAt ?? null)} />
        </div>
        <ul
          data-testid="tests-empty-next-steps"
          className="mt-3 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-on-surface-variant"
        >
          <li>在“产物”中查看切片本地文件与提交引用。</li>
          <li>在证据根中查看名称相关的 dogfood 截图或校验说明。</li>
          <li>当加入目录名匹配的校验包时，此标签页会内联渲染它。</li>
        </ul>
      </div>
    );
  }
  return (
    <div data-testid="tests-tab" className="p-4 space-y-4">
      <header className="flex items-center justify-between border-b border-outline-variant pb-2">
        <div className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface">
          <ToolMark tool="proof" size="xs" />
          测试 / 校验
        </div>
        <div className="font-mono text-[10px] text-on-surface-variant" data-testid="tests-aggregate">
          {tests.aggregate.passCount} 通过，{tests.aggregate.failCount} 失败
          {" · "}{tests.proofPackets.length} 个校验包
        </div>
      </header>
      {tests.proofPackets.map((packet) => (
        <ProofPacketSection key={packet.dirName} sliceName={sliceName} packet={packet} />
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-outline-variant bg-surface-lowest/30 px-2 py-1">
      <div className="text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">{label}</div>
      <div className="mt-0.5 truncate text-on-surface">{value}</div>
    </div>
  );
}

function formatMaybeDate(ts: string | null): string {
  if (!ts) return "未知";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function ProofPacketSection({ sliceName, packet }: { sliceName: string; packet: ProofPacketRendered }) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  return (
    <article
      className="border border-outline-variant bg-surface-lowest"
      data-testid={`tests-packet-${packet.dirName}`}
    >
      <header className="flex items-center justify-between border-b border-outline-variant bg-background px-3 py-2">
        <div
          className={`min-w-0 flex-1 ${BADGE_TEST_TONE_CLASSES[packet.passFailBadge]}`}
          data-testid={`tests-packet-badge-${packet.dirName}`}
        >
          <ProofPacketHeader title={packet.dirName} badge={packet.passFailBadge} />
        </div>
      </header>
      <div className="p-3 space-y-3">
        {packet.primaryMarkdown && (
          <div data-testid={`tests-packet-primary-md-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
              <ToolMark tool={packet.primaryMarkdown.relPath} size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              {packet.primaryMarkdown.relPath}
            </div>
            <pre className="whitespace-pre-wrap break-words bg-background p-3 font-mono text-[10px] text-on-surface">
              {packet.primaryMarkdown.content}
            </pre>
          </div>
        )}

        {packet.screenshots.length > 0 && (
          <section data-testid={`tests-packet-screenshots-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
              <ToolMark tool="screenshot" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              截图（{packet.screenshots.length}）
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {packet.screenshots.map((rel) => (
                <figure key={rel} className="border border-outline-variant">
                  <button
                    type="button"
                    data-testid={`tests-packet-screenshot-open-${rel}`}
                    onClick={() => setSelectedScreenshot(rel)}
                    className="block w-full text-left"
                  >
                    <img
                      data-testid={`tests-packet-screenshot-${rel}`}
                      src={proofAssetUrl(sliceName, rel)}
                      alt={rel}
                      loading="lazy"
                      className="block w-full bg-surface-low"
                    />
                  </button>
                  <figcaption className="bg-background px-2 py-1 font-mono text-[9px] text-on-surface-variant truncate">
                    <ToolMark tool={rel} size="xs" className="mr-1 inline-block align-[-2px]" decorative />
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
        <ProofImageViewer
          sliceName={sliceName}
          relPath={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
          testId="tests-screenshot-viewer"
          imageTestId="tests-screenshot-viewer-image"
          closeTestId="tests-screenshot-viewer-close"
        />

        {packet.videos.length > 0 && (
          <section data-testid={`tests-packet-videos-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
              <ToolMark tool="video" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              视频（{packet.videos.length}）
            </div>
            <div className="space-y-3">
              {packet.videos.map((rel) => (
                <figure key={rel} className="border border-outline-variant">
                  <video
                    data-testid={`tests-packet-video-${rel}`}
                    src={proofAssetUrl(sliceName, rel)}
                    controls
                    preload="metadata"
                    className="block w-full bg-black"
                  />
                  <figcaption className="bg-background px-2 py-1 font-mono text-[9px] text-on-surface-variant truncate">
                    {rel}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {packet.traces.length > 0 && (
          <section data-testid={`tests-packet-traces-${packet.dirName}`}>
            <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
              <ToolMark tool="trace" size="xs" className="mr-1 inline-block align-[-2px]" decorative />
              跟踪记录（下载）
            </div>
            <ul className="font-mono text-[10px]">
              {packet.traces.map((rel) => (
                <li key={rel}>
                  <a
                    href={proofAssetUrl(sliceName, rel)}
                    download
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                  >
                    <ToolMark tool={rel} size="xs" decorative />
                    {rel}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {packet.additionalMarkdown.length > 0 && (
          <details>
            <summary className="cursor-pointer font-mono text-[10px] text-on-surface" data-testid={`tests-packet-additional-md-toggle-${packet.dirName}`}>
              其他 Markdown（{packet.additionalMarkdown.length}）
            </summary>
            <div className="mt-2 space-y-2">
              {packet.additionalMarkdown.map((md) => (
                <div key={md.relPath}>
                  <div className="inline-flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
                    <ToolMark tool={md.relPath} size="xs" decorative />
                    {md.relPath}
                  </div>
                  <pre className="whitespace-pre-wrap break-words bg-background p-2 font-mono text-[9px] text-on-surface">{md.content}</pre>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}
