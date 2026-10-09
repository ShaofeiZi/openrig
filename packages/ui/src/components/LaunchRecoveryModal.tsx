// OPR.0.4.3.22——启动/恢复弹窗（先规划再变更）。
//
// 约定（PRD + 守卫）：
//  - 默认 restore-original；打开时先获取只读的逐席位规划
//    （POST /launch-plan，mutated:false），在任何变更之前（AC-3）；
//  - 每个席位一行，带独立的 TOKEN + PLAN 列——缺 token 的席位渲染为
//    `awaiting-decision`（而非全新启动）并阻塞 restore-original 动作，
//    而可恢复的席位独立保持 `resume-original`（锁定——可恢复席位保持可见）；
//  - `fresh` 是一个明确、有标注、全体席位的操作者选择
//    （改变身份/上下文）→ 映射为逐席位的 `freshLogicalIds`，绝不隐式全局翻转；
//  - 用词仅限已发布的恢复词表（resume-original / awaiting-decision / fresh-primed）
//    ——不做 best-effort（超出范围）。

import { useEffect, useState } from "react";
import { Ban, Check, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.js";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table.js";
import { Button } from "./ui/button.js";
import { StatusPip, type StatusPipStatus } from "./ui/status-pip.js";
import { cn } from "../lib/utils.js";
import { useLaunchPlan, type LaunchPlanNode } from "../hooks/useLaunchPlan.js";
import { useLaunchRig } from "../hooks/mutations.js";
import type { SeatIntendedAction, SeatTokenState } from "../hooks/useRigStatus.js";

type LaunchPolicy = "restore-original" | "fresh";

const verdictPip: Record<SeatIntendedAction, StatusPipStatus> = {
  "resume-original": "running",
  "fresh-primed": "info",
  "awaiting-decision": "warning",
};

// 令牌状态 → 色调。stale / unverified 与 missing 不同（FR-6）：
// stale/unverified 的令牌可见以便重新校验，而非静默折叠为 missing。
const tokenTone: Record<SeatTokenState, string> = {
  present: "text-success",
  missing: "text-tertiary font-bold",
  stale: "text-warning font-bold",
  unverified: "text-warning",
};

export interface LaunchRecoveryModalProps {
  rigId: string;
  rigName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function PolicyOption({
  policy,
  label,
  selected,
  warn,
  sub,
  onSelect,
}: {
  policy: LaunchPolicy;
  label: string;
  selected: boolean;
  warn?: boolean;
  sub: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`launch-policy-${policy}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex-1 border px-3 py-2 text-left",
        selected ? "border-stone-900 bg-stone-900 text-white" : "border-outline bg-white text-stone-700",
        warn && !selected && "border-tertiary/50",
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide">
        {selected ? <Check className="h-3 w-3" /> : null}
        {label}
        {policy === "restore-original" ? (
          <span className={cn("ml-auto text-[8px]", selected ? "text-white/70" : "text-secondary")}>默认</span>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[8px] leading-snug",
          selected ? "text-white/75" : warn ? "text-tertiary" : "text-secondary",
        )}
      >
        {sub}
      </div>
    </button>
  );
}

export function LaunchRecoveryModal({ rigId, rigName, open, onOpenChange }: LaunchRecoveryModalProps) {
  const planMut = useLaunchPlan(rigId);
  const launchMut = useLaunchRig(rigId);
  const [policy, setPolicy] = useState<LaunchPolicy>("restore-original");

  const planNodes: LaunchPlanNode[] = planMut.data?.nodes ?? [];
  const allSeatIds = planNodes.map((n) => n.logicalId);

  // 先规划再动作：弹窗打开时获取只读规划。每次打开重置为 restore-original。
  // `planMut.mutate` / `launchMut.reset` 是稳定的。
  useEffect(() => {
    if (!open) return;
    setPolicy("restore-original");
    launchMut.reset();
    planMut.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rigId]);

  function selectPolicy(next: LaunchPolicy) {
    if (next === policy) return;
    setPolicy(next);
    // 在所选策略下重新获取只读预测：fresh 会为所有席位预测 fresh-primed
    // （明确、有标注的全体席位选择）。
    planMut.mutate(next === "fresh" ? planNodes.map((n) => n.logicalId) : undefined);
  }

  // 在 restore-original 下，任何 awaiting-decision 席位都会阻塞整个动作——
  // restore-original 绝不静默全新启动（诚实约定）。
  const blockedSeats = planNodes.filter((n) => n.intendedAction === "awaiting-decision");
  const isBlocked = policy === "restore-original" && blockedSeats.length > 0;
  const canExecute = !isBlocked && planNodes.length > 0 && !planMut.isPending && !launchMut.isPending;

  function execute() {
    // fresh = 明确、有标注的全体席位操作者选择 → 逐席位 freshLogicalIds。
    launchMut.mutate(policy === "fresh" ? allSeatIds : undefined, {
      onSuccess: () => onOpenChange(false),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="max-w-3xl border-stone-900" data-testid="launch-recovery-modal">
        <DialogHeader>
          <DialogTitle className="font-headline uppercase tracking-tight flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            恢复 {rigName}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] text-secondary">
            先规划再执行——这是只读预览，尚未做任何更改。
          </DialogDescription>
        </DialogHeader>

        {/* 策略选择器——restore-original（默认）+ fresh（无 best-effort）。 */}
        <div className="flex gap-2" data-testid="launch-policy-picker">
          <PolicyOption
            policy="restore-original"
            label="恢复原始"
            selected={policy === "restore-original"}
            sub="仅恢复原始会话。若某席位无法恢复，则大声失败——绝不静默全新启动。"
            onSelect={() => selectPolicy("restore-original")}
          />
          <PolicyOption
            policy="fresh"
            label="全新"
            selected={policy === "fresh"}
            warn
            sub="⚠ 会改变身份/上下文——为所有席位创建新会话。之前的对话上下文不会被恢复。"
            onSelect={() => selectPolicy("fresh")}
          />
        </div>

        {/* 阻塞横幅——诚实约定，置于正中。 */}
        {isBlocked ? (
          <div
            data-testid="launch-blocked-banner"
            className="border border-tertiary bg-tertiary/10 px-3 py-2 flex items-start gap-2"
          >
            <Ban className="h-3.5 w-3.5 text-tertiary shrink-0" />
            <div className="font-mono text-[9px] leading-relaxed text-tertiary">
              <span className="font-bold uppercase">恢复原始已被阻塞</span>——有 {blockedSeats.length} 个席位
              需要决策。恢复原始绝不会静默全新启动。请在下方逐个处理席位，或为整个工作组切换到{" "}
              <span className="underline">全新</span>（会改变身份）。
            </div>
          </div>
        ) : null}

        {planMut.isPending ? (
          <p data-testid="launch-plan-loading" className="font-mono text-[10px] text-secondary py-4">
            正在获取只读规划…
          </p>
        ) : planMut.isError ? (
          <p data-testid="launch-plan-error" className="font-mono text-[10px] text-tertiary py-4">
            无法获取规划：{(planMut.error as Error).message}
          </p>
        ) : (
          <>
            {/* 逐席位规划表——每席位独立的 TOKEN + PLAN 列。 */}
            <Table data-testid="launch-plan-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-[9px]">席位</TableHead>
                  <TableHead className="font-mono text-[9px]">令牌</TableHead>
                  <TableHead className="font-mono text-[9px]">规划</TableHead>
                  <TableHead className="font-mono text-[9px]">提示词 / 备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {planNodes.map((s) => (
                  <TableRow key={s.logicalId} data-testid={`plan-row-${s.logicalId}`}>
                    <TableCell className="py-2 font-mono text-[10px] font-medium">{s.logicalId}</TableCell>
                    <TableCell className="py-2 font-mono text-[9px]" data-testid={`plan-token-${s.logicalId}`}>
                      <span className={cn(tokenTone[s.tokenState])}>{s.tokenState}</span>
                    </TableCell>
                    <TableCell className="py-2" data-testid={`plan-verdict-${s.logicalId}`}>
                      <StatusPip status={verdictPip[s.intendedAction]} variant="pill" label={s.intendedAction} />
                    </TableCell>
                    <TableCell className="py-2 font-mono text-[9px] text-secondary">
                      {s.runtimePrompt ?? s.reason ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {launchMut.isError ? (
              <p data-testid="launch-execute-error" className="font-mono text-[9px] text-tertiary">
                {(launchMut.error as Error).message}
              </p>
            ) : null}
          </>
        )}

        <DialogFooter className="items-center gap-2">
          <p className="mr-auto font-mono text-[8px] text-stone-400 leading-snug">
            来源：由 /api/rigs/:id/launch-plan 组合（只读预测 · mutated:false）
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="font-mono text-[10px]"
            onClick={() => onOpenChange(false)}
            data-testid="launch-cancel"
          >
            取消
          </Button>
          <Button
            variant={policy === "fresh" ? "destructive" : "default"}
            size="sm"
            disabled={!canExecute}
            onClick={execute}
            data-testid="launch-execute"
            className="font-mono text-[10px] tracking-widest"
          >
            {isBlocked
              ? "请先解决阻塞项再恢复"
              : policy === "fresh"
                ? "为所有席位全新启动 ▸"
                : "恢复原始 ▸"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
