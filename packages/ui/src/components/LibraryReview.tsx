import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
// OPR.0.4.6.WF4 (C3b)——工作流形态渲染器现已独立成模块
// （从本文件抽出）；本页导入它。SliceWorkflowGraph 未改动。
import { WorkflowTopologyGraph } from "./workflow/WorkflowTopologyGraph.js";
import { WorkflowInstancesBand } from "./workflow/WorkflowInstancesBand.js";
// V1 attempt-3 Phase 5 P5-1：context-pack + agent-image 的
// “文件”/“补充文件”列表中的文件引用改为 FileReferenceTrigger 包裹的行，
// 使点击 → 抽屉中的 FileViewer。按 content-drawer.md L23-L34 的自动打开触发契约。
// 内容稍后到达（Phase 5 P5-5/P5-6 数据取接可能加实时内容）；FileViewer 空态覆盖
// 无内容的过渡阶段。
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { ForkNowAction } from "./agent-images/ForkNowAction.js";
import {
  useLibraryReview,
  useSpecLibrary,
  setActiveLens,
  clearActiveLens,
  useActiveLens,
  type LibraryRigReview,
  type LibraryAgentReview,
  type LibraryWorkflowReview,
} from "../hooks/useSpecLibrary.js";
import {
  useContextPackLibrary,
  useContextPackPreview,
  type ContextPackEntry,
} from "../hooks/useContextPackLibrary.js";
import {
  useAgentImageLibrary,
  useAgentImagePreview,
  useAgentImagePin,
  type AgentImageEntry,
  type AgentImagePreview,
} from "../hooks/useAgentImageLibrary.js";
import { useQueryClient } from "@tanstack/react-query";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
import { RigSpecDisplay } from "./RigSpecDisplay.js";
import { buildSetupPrompt } from "../lib/build-setup-prompt.js";
import { copyText } from "../lib/copy-text.js";

interface LibraryReviewProps {
  entryId: string;
}

function ProvenanceBadge({ sourcePath, sourceState }: { sourcePath: string; sourceState: string }) {
  return (
    <div className="font-mono text-[9px] text-on-surface-variant" data-testid="library-provenance">
      来源：{sourcePath} · {sourceState}
    </div>
  );
}

function LibraryAgentReviewPage({ review }: { review: LibraryAgentReview }) {
  const navigate = useNavigate();
  const profiles = review.profiles ?? [];
  const resources = review.resources ?? { skills: [], guidance: [], plugins: [], subagents: [] };

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent" className="space-y-6">
        <WorkflowHeader
          eyebrow="库 — 智能体规格"
          title={review.name}
          description={review.description ?? "来自库的智能体规格。"}
          actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>校验</Button>}
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="格式" value="AgentSpec" testId="lib-agent-format" />
          <WorkflowSummaryCard label="版本" value={review.version} testId="lib-agent-version" />
          <WorkflowSummaryCard label="配置档" value={profiles.length} testId="lib-agent-profiles" />
          <WorkflowSummaryCard label="技能" value={resources.skills.length} testId="lib-agent-skills" />
        </WorkflowSummaryGrid>

        <AgentSpecDisplay
          review={review}
          yaml={review.raw}
          testIdPrefix="lib-agent"
          sourcePath={review.sourcePath}
        />
      </div>
    </WorkspacePage>
  );
}

function LibraryRigReviewContent({ review }: { review: LibraryRigReview }) {
  const navigate = useNavigate();
  const [setupPromptCopied, setSetupPromptCopied] = useState(false);
  const { data: agentEntries = [] } = useSpecLibrary("agent");
  const agentEntryByName = new Map(agentEntries.map((entry) => [entry.name, entry]));
  const reviewPods = review.pods ?? [];
  const reviewNodes = review.nodes ?? [];
  const reviewEdges = review.edges ?? [];

  const resolveMemberAgent = (agentRef: string) => {
    if (!agentRef.startsWith("local:")) return null;
    const refPath = agentRef.slice("local:".length);

    // 按工作组源目录解析 ref 路径
    const rigDir = review.sourcePath.replace(/\/[^/]+$/, "");
    const segments = `${rigDir}/${refPath}`.split("/");
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === "..") { resolved.pop(); }
      else if (seg !== "." && seg !== "") { resolved.push(seg); }
    }
    const resolvedDir = "/" + resolved.join("/");

    // 按 sourcePath 前缀匹配库条目（agent 目录含 agent.yaml）
    return agentEntries.find((entry) => entry.sourcePath.startsWith(resolvedDir + "/")) ?? null;
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-rig" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.services ? "库 — 托管应用" : "库 — 工作组规格"}
          title={review.name}
          description={review.summary ?? "来自库的工作组规格。"}
          actions={
            <div className="flex gap-2">
              {review.services && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="copy-setup-prompt"
                  onClick={() => void (async () => {
                    const copied = await copyText(buildSetupPrompt({
                      name: review.name,
                      summary: review.summary,
                      sourcePath: review.sourcePath,
                    }));
                    if (!copied) return;
                    setSetupPromptCopied(true);
                    window.setTimeout(() => setSetupPromptCopied(false), 2000);
                  })()}
                >
                  {setupPromptCopied ? "已复制" : "复制安装提示词"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>导入</Button>
            </div>
          }
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState={review.sourceState} />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="格式" value={review.format === "pod_aware" ? "Pod 感知" : "旧版"} testId="lib-rig-format" />
          {review.services && (
            <WorkflowSummaryCard label="类型" value="智能体托管应用" testId="lib-rig-type" />
          )}
          {review.services && reviewPods.length > 0 && (() => {
            const specialistPod = reviewPods.find((p) => p.members.some((m) => m.id === "specialist"));
            if (!specialistPod) return null;
            return (
              <WorkflowSummaryCard
                label="专家智能体"
                value={`${specialistPod.id}.specialist`}
                testId="lib-rig-specialist"
              />
            );
          })()}
          <WorkflowSummaryCard
            label={review.format === "pod_aware" ? "Pod" : "节点"}
            value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
            testId="lib-rig-pods"
          />
          <WorkflowSummaryCard
            label="成员"
            value={review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
              : reviewNodes.length}
            testId="lib-rig-members"
          />
          <WorkflowSummaryCard
            label="边"
            value={reviewEdges.length + (review.format === "pod_aware"
              ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
              : 0)}
            testId="lib-rig-edges"
          />
        </WorkflowSummaryGrid>

        <RigSpecDisplay
          review={review}
          yaml={review.raw}
          testIdPrefix="lib"
          yamlTestId="lib-rig-yaml"
          showEnvironmentTab={!!review.services}
          onMemberClick={(podId, member) => {
            const agentEntry = resolveMemberAgent(member.agentRef);
            if (agentEntry) {
              void navigate({ to: "/specs/library/$entryId", params: { entryId: agentEntry.id } });
            }
          }}
        />
      </div>
    </WorkspacePage>
  );
}

export function LibraryReview({ entryId }: LibraryReviewProps) {
  // PL-014：context_packs 位于 /api/context-packs/library，id 前缀 "context-pack:"。
  // 在调用 useLibraryReview 前分发到包专属评审页（后者对 context-pack id 会 404，
  // 因走的是 spec-library 路由）。
  if (entryId.startsWith("context-pack:")) {
    return <LibraryContextPackReviewPage entryId={entryId} />;
  }
  // PL-016：agent_images 位于 /api/agent-images/library，id 前缀 "agent-image:"。
  if (entryId.startsWith("agent-image:")) {
    return <LibraryAgentImageReviewPage entryId={entryId} />;
  }
  return <LibrarySpecReview entryId={entryId} />;
}

function LibrarySpecReview({ entryId }: LibraryReviewProps) {
  const navigate = useNavigate();
  const { data: review, isLoading, error } = useLibraryReview(entryId);

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">正在加载规格评审…</div>
      </WorkspacePage>
    );
  }

  if (error || !review) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader eyebrow="库" title="未找到规格" description={(error as Error)?.message ?? "无法加载规格。"} />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回库</Button>
        </div>
      </WorkspacePage>
    );
  }

  if (review.kind === "agent") {
    return <LibraryAgentReviewPage review={review as LibraryAgentReview} />;
  }

  if (review.kind === "workflow") {
    return <LibraryWorkflowReviewPage review={review as LibraryWorkflowReview} />;
  }

  return <LibraryRigReviewContent review={review as LibraryRigReview} />;
}

// --- 规格库 v0 中的工作流：工作流评审变体 ---


function LibraryWorkflowReviewPage({ review }: { review: LibraryWorkflowReview }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: activeLens } = useActiveLens();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isThisLensActive = activeLens?.specName === review.name && activeLens?.specVersion === review.version;

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      await setActiveLens(review.name, review.version);
      await queryClient.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
      await queryClient.invalidateQueries({ queryKey: ["slices"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearActiveLens();
      await queryClient.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
      await queryClient.invalidateQueries({ queryKey: ["slices"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-workflow" className="space-y-6">
        <WorkflowHeader
          eyebrow={review.isBuiltIn ? "库 — 工作流（内置）" : "库 — 工作流"}
          title={`${review.name} v${review.version}`}
          description={review.purpose ?? "来自库的工作流规格。"}
          actions={
            <div className="flex gap-2 items-center">
              {isThisLensActive ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-deactivate-lens"
                  onClick={() => void deactivate()}
                  disabled={busy}
                >
                  {busy ? "…" : "停用镜头"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="workflow-activate-lens"
                  onClick={() => void activate()}
                  disabled={busy}
                >
                  {busy ? "…" : "激活为镜头"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回</Button>
            </div>
          }
        />
        <ProvenanceBadge sourcePath={review.sourcePath} sourceState="library_item" />
        {error && <div data-testid="workflow-lens-error" className="font-mono text-[10px] text-red-600">{error}</div>}

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="格式" value="WorkflowSpec" testId="lib-wf-format" />
          <WorkflowSummaryCard label="版本" value={review.version} testId="lib-wf-version" />
          <WorkflowSummaryCard label="角色" value={review.rolesCount} testId="lib-wf-roles" />
          <WorkflowSummaryCard label="步骤" value={review.stepsCount} testId="lib-wf-steps" />
          <WorkflowSummaryCard label="目标工作组" value={review.targetRig ?? "（任意）"} testId="lib-wf-target-rig" />
          <WorkflowSummaryCard label="来源" value={review.isBuiltIn ? "内置" : "用户文件"} testId="lib-wf-source" />
        </WorkflowSummaryGrid>

        <div data-testid="workflow-terminal-rule" className="flex items-center gap-2 border border-outline-variant/40 bg-surface-lowest/10 px-3 py-2 font-mono text-[10px] text-on-surface">
          <ToolMark tool="terminal" size="xs" decorative />
          <span className="text-on-surface-variant uppercase tracking-[0.16em] text-[8px]">协调终端回合：</span>
          {review.terminalTurnRule}
        </div>

        <WorkflowTopologyGraph topology={review.topology} />

        {/* OPR.0.4.6.WF4 (C4)——A-lite “本规格的运行”实例带。
            quietWhenEmpty：零实例时不渲染任何内容，使无实时运行的规格与发布的
            库页面字节一致（零回归）。 */}
        <WorkflowInstancesBand workflowName={review.name} workflowVersion={review.version} testId="library-instances-band" />

        <div className="space-y-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">步骤</div>
          <div className="space-y-1">
            {review.steps.map((step) => (
              <div
                key={step.stepId}
                data-testid={`workflow-step-${step.stepId}`}
                className="border border-outline-variant/40 bg-surface-lowest/5 px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-on-surface">{step.stepId}</span>
                  <span className="font-mono text-[9px] text-on-surface-variant">{step.role}</span>
                </div>
                {step.objective && <div className="mt-1 text-[10px] text-on-surface-variant leading-tight">{step.objective}</div>}
                {step.allowedNextSteps.length > 0 && (
                  <div className="mt-1 font-mono text-[9px] text-on-surface-variant">
                    下一步：{step.allowedNextSteps.map((n) => `${n.stepId} (${n.role})`).join(", ")}
                  </div>
                )}
                {step.allowedExits.length > 0 && (
                  <div className="font-mono text-[9px] text-on-surface-variant">
                    出口：{step.allowedExits.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}

// --- Rig 上下文 / 可组合上下文注入 v0（PL-014）：context_pack 评审页 ---

function LibraryContextPackReviewPage({ entryId }: { entryId: string }) {
  const navigate = useNavigate();
  const { data: packs = [], isLoading: packsLoading, error: packsError } = useContextPackLibrary();
  const entry = packs.find((p) => p.id === entryId) ?? null;
  // Atom 5：预览按包的路径形 ref 寻址，而非其不透明 id。
  const { data: preview, isLoading: previewLoading } = useContextPackPreview(entry ? entry.relativePath : null);

  if (packsLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">正在加载上下文包…</div>
      </WorkspacePage>
    );
  }
  if (packsError || !entry) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="资料库"
            title="未找到上下文包"
            description={(packsError as Error)?.message ?? `没有 id 为 ${entryId} 的上下文包。`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回库</Button>
        </div>
      </WorkspacePage>
    );
  }

  return <ContextPackReviewBody entry={entry} preview={preview} previewLoading={previewLoading} />;
}

function ContextPackReviewBody({
  entry,
  preview,
  previewLoading,
}: {
  entry: ContextPackEntry;
  preview: ReturnType<typeof useContextPackPreview>["data"];
  previewLoading: boolean;
}) {
  const navigate = useNavigate();

  return (
    <WorkspacePage>
      <div data-testid="library-review-context-pack" className="space-y-4">
        <WorkflowHeader
          eyebrow={`库 — 上下文包${entry.sourceType === "builtin" ? "（内置）" : ""}`}
          title={entry.name}
          description={entry.purpose ?? "操作手撰写的可组合上下文包。"}
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回库</Button>
          }
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="版本" value={entry.version} testId="lib-pack-version" />
          <WorkflowSummaryCard label="文件" value={entry.files.length} testId="lib-pack-files" />
          <WorkflowSummaryCard
            label="Token（约）"
            value={String(entry.derivedEstimatedTokens)}
            testId="lib-pack-tokens"
          />
          <WorkflowSummaryCard label="来源" value={entry.sourceType} testId="lib-pack-source" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-pack-source-path" className="font-mono text-[9px] text-on-surface-variant">
          路径：{entry.sourcePath}
        </div>

        <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
          <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
            文件
          </header>
          <ul data-testid="lib-pack-file-list" className="divide-y divide-outline-variant">
            {entry.files.map((f) => {
              const missing = f.bytes === null;
              return (
                <li
                  key={f.path}
                  data-testid={`lib-pack-file-${f.path}`}
                  data-missing={missing ? "true" : "false"}
                  className={`font-mono text-[10px] ${missing ? "text-red-700" : "text-on-surface"}`}
                >
                  <FileReferenceTrigger
                    data={{ path: f.path, absolutePath: f.absolutePath }}
                    testId={`lib-pack-file-trigger-${f.path}`}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-low/60 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold truncate underline decoration-dotted decoration-outline">{f.path}</span>
                      <span className="font-mono text-[8px] text-on-surface-variant shrink-0">
                        角色：{f.role}
                        {missing
                          ? " · 缺失"
                          : ` · ${f.bytes}B · 约 ${f.estimatedTokens} tokens`}
                      </span>
                    </div>
                    {f.summary && (
                      <div className="mt-0.5 text-on-surface-variant text-[9px]">{f.summary}</div>
                    )}
                  </FileReferenceTrigger>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
          <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
            包预览
          </header>
          {previewLoading && (
            <div className="px-3 py-2 font-mono text-[9px] text-on-surface-variant">正在加载包…</div>
          )}
          {preview && (
            <>
              {preview.missingFiles.length > 0 && (
                <div data-testid="lib-pack-missing-warning" className="px-3 py-2 font-mono text-[9px] text-red-700 border-b border-outline-variant">
                  警告：清单引用了 {preview.missingFiles.length} 个文件，但磁盘上缺失。
                </div>
              )}
              <pre
                data-testid="lib-pack-bundle-text"
                className="font-mono text-[9px] text-on-surface bg-background px-3 py-2 max-h-96 overflow-y-auto whitespace-pre-wrap"
              >
                {preview.bundleText}
              </pre>
            </>
          )}
        </section>
      </div>
    </WorkspacePage>
  );
}

// --- Fork 原语 + 起点智能体镜像 v0（PL-016）：agent-image 评审变体。
//     展示清单 + 统计徽章 + 谱系 + 用作起点片段 + 固定/取消固定按钮。 ---

function LibraryAgentImageReviewPage({ entryId }: { entryId: string }) {
  const navigate = useNavigate();
  const { data: images = [], isLoading: imagesLoading, error: imagesError } = useAgentImageLibrary();
  const entry = images.find((i) => i.id === entryId) ?? null;
  const { data: preview, isLoading: previewLoading } = useAgentImagePreview(entry ? entryId : null);

  if (imagesLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">正在加载智能体镜像…</div>
      </WorkspacePage>
    );
  }
  if (imagesError || !entry) {
    return (
      <WorkspacePage>
        <div data-testid="library-review-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="资料库"
            title="未找到智能体镜像"
            description={(imagesError as Error)?.message ?? `没有 id 为 ${entryId} 的智能体镜像。`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回库</Button>
        </div>
      </WorkspacePage>
    );
  }
  return <AgentImageReviewBody entry={entry} preview={preview} previewLoading={previewLoading} />;
}

function AgentImageReviewBody({
  entry,
  preview,
  previewLoading,
}: {
  entry: AgentImageEntry;
  preview: AgentImagePreview | undefined;
  previewLoading: boolean;
}) {
  const navigate = useNavigate();
  const pinMutation = useAgentImagePin();
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const onCopySnippet = async () => {
    if (!preview?.starterSnippet) return;
    const ok = await copyText(preview.starterSnippet);
    if (ok) {
      setSnippetCopied(true);
      window.setTimeout(() => setSnippetCopied(false), 2000);
    }
  };

  const onTogglePin = async () => {
    setPinError(null);
    try {
      await pinMutation.mutateAsync({ id: entry.id, pin: !entry.pinned });
    } catch (err) {
      setPinError((err as Error).message);
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="library-review-agent-image" className="space-y-4">
        <WorkflowHeader
          eyebrow={`库 — 智能体镜像${entry.sourceType === "builtin" ? "（内置）" : ""}`}
          title={`${entry.name} v${entry.version}`}
          description={entry.notes ?? `${entry.sourceSeat} 的快照。`}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="agent-image-pin-toggle"
                onClick={() => void onTogglePin()}
                disabled={pinMutation.isPending}
              >
                {entry.pinned ? "取消固定" : "固定"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>返回库</Button>
            </div>
          }
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard
            label="运行时"
            value={<RuntimeBadge runtime={entry.runtime} size="sm" compact variant="inline" />}
            testId="lib-image-runtime"
          />
          <WorkflowSummaryCard label="分叉" value={String(entry.stats.forkCount)} testId="lib-image-forks" />
          <WorkflowSummaryCard label="Token（约）" value={String(entry.derivedEstimatedTokens)} testId="lib-image-tokens" />
          <WorkflowSummaryCard label="大小" value={`${entry.stats.estimatedSizeBytes}B`} testId="lib-image-size" />
        </WorkflowSummaryGrid>

        <div data-testid="lib-image-source" className="font-mono text-[9px] text-on-surface-variant space-y-0.5">
          <div>来源席位：{entry.sourceSeat}</div>
          {/* 展示 source_cwd，使操作手看到父会话是在
            * 何处创建的。较旧的清单诚实地渲染 "(unknown)"。 */}
          <div data-testid="lib-image-source-cwd">来源工作目录：{entry.sourceCwd ?? "（未知——Finding-2 之前的清单）"}</div>
          <div>创建：{entry.createdAt}</div>
          <div>最近使用：{entry.stats.lastUsedAt ?? "从未"}</div>
          <div>路径：{entry.sourcePath}</div>
          <div data-testid="lib-image-pinned" className={entry.pinned ? "text-amber-700 font-bold" : ""}>已固定：{String(entry.pinned)}</div>
        </div>

        {entry.lineage.length > 0 && (
          <section data-testid="lib-image-lineage" className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
            <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
              谱系
            </header>
            <div className="px-3 py-2 font-mono text-[10px] text-on-surface">
              {entry.lineage.join(" → ")} → <span className="font-bold">{entry.name}</span>
            </div>
          </section>
        )}

        <ForkNowAction entry={entry} />

        <section data-testid="lib-image-starter-snippet" className="border border-outline bg-surface-lowest px-3 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface">用作起点</div>
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-image-copy-snippet"
              onClick={() => void onCopySnippet()}
              disabled={!preview?.starterSnippet}
            >
              {snippetCopied ? "已复制" : "复制片段"}
            </Button>
          </div>
          <div className="font-mono text-[9px] text-on-surface-variant">
            粘贴到你的 agent.yaml 的 session_source。实例化器在启动时经后台服务 AgentImageLibraryService 解析该镜像。
          </div>
          {previewLoading && <div className="font-mono text-[9px] text-on-surface-variant">正在加载片段…</div>}
          {preview?.starterSnippet && (
            <pre
              data-testid="lib-image-snippet-text"
              className="font-mono text-[10px] bg-background border border-outline-variant px-2 py-1 whitespace-pre-wrap"
            >
              {preview.starterSnippet}
            </pre>
          )}
        </section>

        {pinError && (
          <div data-testid="lib-image-pin-error" className="font-mono text-[9px] text-red-600">{pinError}</div>
        )}

        {entry.files.length > 0 && (
          <section className="border border-outline-variant/40 bg-surface-lowest/[0.08]">
            <header className="border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
              补充文件
            </header>
            <ul className="divide-y divide-outline-variant">
              {entry.files.map((f) => (
                <li
                  key={f.path}
                  className="font-mono text-[10px] text-on-surface"
                  data-testid={`lib-image-file-${f.path}`}
                >
                  <FileReferenceTrigger
                    data={{ path: f.path, absolutePath: f.absolutePath }}
                    testId={`lib-image-file-trigger-${f.path}`}
                    className="block w-full px-3 py-2 text-left hover:bg-surface-low/60 transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold truncate underline decoration-dotted decoration-outline">{f.path}</span>
                      <span className="font-mono text-[8px] text-on-surface-variant shrink-0">
                        角色：{f.role}
                        {f.bytes === null ? " · 缺失" : ` · ${f.bytes}B`}
                      </span>
                    </div>
                    {f.summary && <div className="mt-0.5 text-on-surface-variant text-[9px]">{f.summary}</div>}
                  </FileReferenceTrigger>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </WorkspacePage>
  );
}
