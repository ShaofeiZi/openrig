import { useState } from "react";
import { useSnapshots } from "../hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot } from "../hooks/mutations.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: string;
  error?: string;
}

interface SnapshotPanelProps {
  rigId: string;
}

function formatAge(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} 天前`;
}

// 复用共享的 restore-status-colors.ts —— 恢复状态词表的唯一真源

export function SnapshotPanel({ rigId }: SnapshotPanelProps) {
  const { data: snapshots = [], isPending: loading, error: fetchError } = useSnapshots(rigId);
  const createSnapshot = useCreateSnapshot(rigId);
  const restoreSnapshot = useRestoreSnapshot(rigId);

  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreNodeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = () => {
    setError(null);
    createSnapshot.mutate(undefined, {
      onError: (err) => setError(err.message),
    });
  };

  const handleRestore = (snapshotId: string) => {
    setError(null);
    setRestoreResult(null);
    restoreSnapshot.mutate(snapshotId, {
      onSuccess: (data) => {
        setRestoreResult((data as { nodes?: RestoreNodeResult[] }).nodes ?? []);
        setConfirmRestore(null);
      },
      onError: (err) => {
        setError(err.message);
        setConfirmRestore(null);
      },
    });
  };

  return (
    <div
      data-testid="snapshot-panel"
      className="vellum-heavy border-l-2 border-on-surface shadow-[-10px_0_30px_rgba(46,52,46,0.05)] p-spacing-6 lg:min-w-[280px] lg:max-w-[320px] overflow-y-auto relative"
    >
      {/* 十字对准标记 */}
      <div className="absolute top-2 left-2 w-2 h-2 crosshair" />
      <div className="absolute top-2 right-2 w-2 h-2 crosshair" />
      <div className="absolute bottom-2 left-2 w-2 h-2 crosshair" />
      <div className="absolute bottom-2 right-2 w-2 h-2 crosshair" />

      {/* 头部 */}
      <div className="flex justify-between items-start mb-spacing-6">
        <div>
          <h3 className="font-headline text-2xl font-extrabold uppercase tracking-tighter leading-none">
            快照
          </h3>
          <div className="font-mono text-[9px] text-on-surface-variant mt-1">
            {snapshots.length} 个快照
          </div>
        </div>
        <button
          className="px-2 py-0.5 border border-on-surface font-headline font-bold text-[9px] uppercase tracking-widest bg-surface-lowest/50 hover:bg-inverse-surface hover:text-background transition-all"
          onClick={handleCreate}
          disabled={createSnapshot.isPending}
        >
          {createSnapshot.isPending ? "创建中…" : "创建"}
        </button>
      </div>

      {/* 错误 */}
      {(error ?? fetchError?.message) && (
        <div data-testid="restore-error" className="stamp-badge mb-spacing-3 w-full">
          {error ?? fetchError?.message}
        </div>
      )}

      {/* 恢复结果 */}
      {restoreResult && (
        <div data-testid="restore-result" className="mb-spacing-4 p-spacing-3 bg-surface-low">
          <div className="font-mono text-[9px] text-on-surface-variant uppercase mb-spacing-2">恢复完成</div>
          <div className="space-y-spacing-1">
            {restoreResult.map((n) => (
              <div key={n.nodeId} className="flex items-center justify-between font-mono text-[10px]">
                <span>{n.logicalId}</span>
                <span className={getRestoreStatusColorClass(n.status)} data-testid={`restore-status-${n.logicalId}`}>
                  {n.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 恢复中 */}
      {restoreSnapshot.isPending && (
        <div data-testid="restore-loading" className="font-mono text-[10px] text-on-surface-variant mb-spacing-3">
          正在恢复…
        </div>
      )}

      {/* 快照列表 */}
      {loading ? (
        <div data-testid="snapshot-loading" className="space-y-spacing-2">
          {[1, 2].map((i) => (
            <div key={i} className="bg-surface-low p-spacing-3">
              <div className="h-4 w-32 shimmer mb-spacing-2" />
              <div className="h-3 w-48 shimmer" />
            </div>
          ))}
        </div>
      ) : snapshots.length === 0 ? (
        <div className="font-mono text-[10px] text-on-surface-variant py-spacing-4 text-center italic">
          暂无快照
        </div>
      ) : (
        <div className="space-y-spacing-2">
          {snapshots.map((snap) => (
            <div key={snap.id} className="bg-surface-low p-spacing-3 hover:bg-surface-mid transition-colors">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-mono text-[10px] font-bold" data-testid={`snap-id-${snap.id}`}>
                    {snap.id.slice(0, 12)}
                  </div>
                  <div className="font-mono text-[9px] text-on-surface-variant mt-0.5">
                    {snap.kind} &middot; {formatAge(snap.createdAt)}
                  </div>
                </div>
                <button
                  className="font-mono text-[9px] font-bold border-b border-on-surface hover:bg-inverse-surface hover:text-background transition-all px-1"
                  data-testid={`restore-btn-${snap.id}`}
                  onClick={() => setConfirmRestore(snap.id)}
                >
                  恢复
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 确认对话框 */}
      <Dialog open={confirmRestore !== null} onOpenChange={(open) => { if (!open) setConfirmRestore(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline text-xl font-extrabold uppercase tracking-tighter">恢复快照</DialogTitle>
            <DialogDescription className="text-body-sm text-on-surface-variant">
              将从快照 {confirmRestore?.slice(0, 12)} 恢复工作组。现有会话将被重启。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              data-testid={confirmRestore ? `cancel-restore-${confirmRestore}` : undefined}
              onClick={() => setConfirmRestore(null)}
            >
              取消
            </Button>
            <Button
              variant="default"
              data-testid={confirmRestore ? `confirm-restore-${confirmRestore}` : undefined}
              onClick={() => confirmRestore && handleRestore(confirmRestore)}
            >
              确认恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
