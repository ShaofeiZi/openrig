import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import { displayAgentName } from "../lib/display-name.js";
import { shortId } from "../lib/display-id.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";
import { useSelectedHostId } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import {
  useAdoptSession,
  useDiscoveredSessions,
  useDiscoveryScan,
  type DiscoveredSession,
  type DiscoveryAdoptTarget,
} from "../hooks/useDiscovery.js";

export type DiscoveryPlacementTarget =
  | {
      kind: "node";
      rigId: string;
      logicalId: string;
      eligible: boolean;
      reason?: string | null;
    }
  | {
      kind: "pod";
      rigId: string;
      podId: string;
      podNamespace: string | null;
      podLabel: string | null;
      eligible: boolean;
      reason?: string | null;
    }
  | null;

interface DiscoveryPanelProps {
  onClose: () => void;
  selectedDiscoveredId: string | null;
  onSelectDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  onClearPlacement: () => void;
}

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function attachCommand(session: DiscoveredSession): string {
  const target = session.tmuxWindow ? `${session.tmuxSession}:${session.tmuxWindow}` : session.tmuxSession;
  return `tmux attach -t ${shellQuote(target)}`;
}

function suggestMemberName(sessionName: string): string {
  const tail = sessionName.split(/[@:]/)[0] ?? sessionName;
  const segments = tail.split(/[-_.]/).filter(Boolean);
  const candidate = (segments.at(-1) ?? tail).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return candidate || "member";
}

function targetNodeLabel(logicalId: string): string {
  if (logicalId.includes(".")) {
    return displayAgentName(logicalId);
  }
  return logicalId.length > 12 ? shortId(logicalId) : logicalId;
}

function targetPodLabel(target: Extract<DiscoveryPlacementTarget, { kind: "pod" }>): string {
  return target.podLabel ?? target.podNamespace ?? shortId(target.podId);
}

function CopyActionButton({
  label,
  activeLabel,
  onClick,
  testId,
  tool,
}: {
  label: string;
  activeLabel: string;
  onClick: () => boolean | Promise<boolean>;
  testId?: string;
  tool?: string;
}) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    const ok = await onClick();
    if (!ok) return;
    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = null;
    }, 900);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={() => { void handleClick(); }}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[7px] uppercase transition-colors",
        active
          ? "bg-inverse-surface text-background border-on-surface"
          : "bg-surface-lowest text-on-surface border-outline-variant hover:bg-surface-low",
      )}
    >
      {tool ? <ToolMark tool={tool} size="xs" /> : null}
      <span>{active ? activeLabel : label}</span>
    </button>
  );
}

export function DiscoveryPanel({
  onClose,
  selectedDiscoveredId,
  onSelectDiscoveredId,
  placementTarget,
  onClearPlacement,
}: DiscoveryPanelProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentRigId = parseCurrentRigId(pathname);
  // OPR.0.4.6.MH2 rev1-r2 重新裁定 B1：采纳是本地变更——
  // 目标/采纳流程在远端选择下从不渲染（shell 也在任何主机切换时清除放置；
  // 这是面板侧的 brace）。
  const panelIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const { data: sessions = [] } = useDiscoveredSessions({
    status: "active",
    runtimeHint: ["claude-code", "codex"],
    minConfidence: "medium",
  });
  const scanMutation = useDiscoveryScan();
  const adoptMutation = useAdoptSession();
  const selectedSession = sessions.find((session) => session.id === selectedDiscoveredId) ?? null;
  const [memberName, setMemberName] = useState("");

  useEffect(() => {
    if (selectedSession && placementTarget?.kind === "pod") {
      setMemberName((current) => current || suggestMemberName(selectedSession.tmuxSession));
      return;
    }
    if (!selectedSession || !placementTarget || placementTarget.kind !== "pod") {
      setMemberName("");
    }
  }, [selectedSession, placementTarget]);

  const selectedCardStatus = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    if (!currentRigId) {
      return "在资源管理器中选择一个工作组以放置所选会话。";
    }

    if (!placementTarget) {
      return `已选择 ${selectedSession.tmuxSession}。点击可用节点绑定它，或点击 Pod 将其添加到那里。`;
    }

    if (!placementTarget.eligible) {
      return placementTarget.reason ?? "该目标无法接收所选会话。";
    }

    if (placementTarget.kind === "node") {
      return `将 ${selectedSession.tmuxSession} 绑定到 ${targetNodeLabel(placementTarget.logicalId)}。`;
    }

    return `将 ${selectedSession.tmuxSession} 添加到 ${targetPodLabel(placementTarget)} Pod。`;
  }, [currentRigId, placementTarget, selectedSession]);

  const handleConfirm = () => {
    if (!selectedSession || !currentRigId || !placementTarget || !placementTarget.eligible) return;

    let target: DiscoveryAdoptTarget;
    if (placementTarget.kind === "node") {
      target = { kind: "node", logicalId: placementTarget.logicalId };
    } else {
      if (!placementTarget.podNamespace) return;
      target = {
        kind: "pod",
        podId: placementTarget.podId,
        podNamespace: placementTarget.podNamespace,
        memberName: memberName.trim(),
      };
    }

    adoptMutation.mutate(
      { discoveredId: selectedSession.id, rigId: currentRigId, target },
      {
        onSuccess: () => {
          onSelectDiscoveredId(null);
          onClearPlacement();
        },
      },
    );
  };

  return (
    <aside
      data-testid="discovery-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-outline-variant/25 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-on-surface truncate">发现</h2>
        <button
          data-testid="discovery-close"
          onClick={onClose}
          className="text-on-surface-variant hover:text-on-surface text-sm"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      <div className="border-b border-outline-variant/35 px-4 py-3 shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">清单</div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="discovery-scan-now"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            {scanMutation.isPending ? "扫描中…" : "立即扫描"}
          </Button>
        </div>
        <Link
          to="/discovery/inventory"
          data-testid="discovery-open-inventory"
          onClick={onClose}
          className="inline-flex items-center border border-outline-variant bg-surface-lowest px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.12em] text-on-surface transition-colors hover:bg-surface-low hover:text-on-surface"
        >
          旧版清单页
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {sessions.length === 0 ? (
          <div data-testid="discovery-empty" className="font-mono text-[10px] text-on-surface-variant">
            当前没有可见的运行中 Claude 或 Codex 会话。
          </div>
        ) : (
          sessions.map((session) => {
            const selected = session.id === selectedDiscoveredId;
            return (
              <div
                key={session.id}
                data-testid={`discovery-session-${session.id}`}
                className={cn(
                  "border border-outline-variant bg-surface-lowest/60 px-3 py-3",
                  selected && "border-emerald-500 shadow-[0_10px_24px_rgba(34,197,94,0.16)]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <RuntimeBadge runtime={session.runtimeHint} size="xs" compact className="bg-surface-lowest/45" />
                      <div className="font-mono text-[10px] text-on-surface truncate" title={session.tmuxSession}>
                        {session.tmuxSession}
                      </div>
                    </div>
                    {session.cwd ? (
                      <div className="mt-1 font-mono text-[9px] text-on-surface-variant truncate" title={session.cwd}>
                        {session.cwd}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant={selected ? "tactical" : "ghost"}
                    size="sm"
                    data-testid={`discovery-select-${session.id}`}
                    onClick={() => onSelectDiscoveredId(selected ? null : session.id)}
                  >
                    {selected ? "已选择" : "选择"}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <CopyActionButton
                    label="复制 tmux"
                    activeLabel="已复制"
                    testId={`discovery-copy-tmux-${session.id}`}
                    tool="tmux"
                    onClick={async () => copyText(attachCommand(session))}
                  />
                  {session.cwd ? (
                    <CopyActionButton
                      label="复制 cwd"
                      activeLabel="已复制"
                      testId={`discovery-copy-cwd-${session.id}`}
                      onClick={async () => copyText(session.cwd ?? "")}
                    />
                  ) : null}
                </div>
                {selected ? (
                  <div className="mt-3 space-y-2 border-t border-emerald-200/80 pt-3">
                    {selectedCardStatus ? (
                      <div
                        data-testid="discovery-selected-session-status"
                        className="border border-emerald-300/80 bg-surface-lowest/70 px-2.5 py-2 font-mono text-[10px] leading-5 text-on-surface"
                      >
                        {selectedCardStatus}
                      </div>
                    ) : null}

                    {placementTarget && panelIsRemote ? (
                      <div
                        data-testid="discovery-remote-readonly"
                        data-remote-readonly="true"
                        className="border border-outline-variant bg-surface-lowest/70 px-2.5 py-2 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
                      >
                        采纳是本地操作——查看远端主机时只读
                      </div>
                    ) : null}

                    {placementTarget && !panelIsRemote && !placementTarget.eligible ? (
                      <div
                        data-testid="discovery-target-error"
                        className="border border-red-200 bg-red-50/80 px-2.5 py-2 font-mono text-[9px] text-red-700"
                      >
                        {placementTarget.reason ?? "该目标不可用。"}
                      </div>
                    ) : null}

                    {placementTarget?.eligible && !panelIsRemote ? (
                      <div className="space-y-2 border border-emerald-300/80 bg-surface-lowest/70 px-3 py-2" data-testid="discovery-target-card">
                        <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-emerald-800">目标</div>
                        <div data-testid="discovery-target-summary" className="font-mono text-[10px] text-on-surface">
                          {placementTarget.kind === "node"
                            ? `已选择 ${targetNodeLabel(placementTarget.logicalId)}`
                            : `已选择 ${targetPodLabel(placementTarget)} Pod`}
                        </div>
                        {placementTarget.kind === "pod" ? (
                          <div className="space-y-1">
                            <label className="font-mono text-[8px] uppercase tracking-[0.16em] text-emerald-800" htmlFor="discovery-member-name">
                              成员名称
                            </label>
                            <input
                              id="discovery-member-name"
                              data-testid="discovery-member-name-input"
                              value={memberName}
                              onChange={(event) => setMemberName(event.target.value)}
                              className="w-full bg-transparent border-b border-emerald-300 py-1 font-mono text-[10px] text-on-surface focus:outline-none focus:border-emerald-700"
                            />
                          </div>
                        ) : null}
                        {adoptMutation.isError ? (
                          <div data-testid="discovery-adopt-error" className="font-mono text-[9px] text-red-600">
                            {adoptMutation.error.message}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="tactical"
                            size="sm"
                            data-testid="discovery-confirm-adopt"
                            disabled={adoptMutation.isPending || (placementTarget.kind === "pod" && !memberName.trim())}
                            onClick={handleConfirm}
                          >
                            {adoptMutation.isPending ? "采纳中…" : "采纳"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="discovery-clear-target"
                            onClick={onClearPlacement}
                          >
                            清除
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
