// Slice 24 —— LaunchCmuxButton。
//
// 工作组范围的“在 CMUX 中启动”按钮。点击 → 经 launchRigCmux POST /api/rigs/:rigId/cmux/launch。
// 在按钮紧邻处内联渲染状态（加载 / 成功 / 错误），而非用单独的 toast 组件——
// 使工作组范围的标签栏自包含。
//
// 按 README §Mobile + §Button 位置：挂载在工作组范围标签栏（Option C 位置，
// 跨所有工作组范围 view-mode 标签页常驻）；通过 Tailwind 响应式类在 lg 断点以下隐藏。

import { useEffect, useRef } from "react";
import { launchRigCmux } from "../../hooks/launchRigCmux.js";
import { postOpenCmux } from "../../hooks/useCmuxLaunch.js";

interface LaunchCmuxButtonProps {
  rigId: string;
}

const SUCCESS_TOAST_TIMEOUT_MS = 6000;
const ERROR_TOAST_TIMEOUT_MS = 8000;

export function LaunchCmuxButton({ rigId }: LaunchCmuxButtonProps) {
  // 把这个启动器的瞬态状态留在 React 渲染之外。拓扑表格视图在这个兄弟按钮于
  // 点击处理期间调度 React state 时可能 render-spin；cmux 启动是外部副作用，
  // 因此一个极小的无控状态岛更安全。
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openMissingRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const inFlightRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const lastMissingRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const setPendingUi = (pending: boolean) => {
    const button = buttonRef.current;
    if (!button) return;
    button.disabled = pending;
    button.setAttribute("aria-busy", pending ? "true" : "false");
    button.textContent = pending ? "正在启动…" : "在 CMUX 中启动";
  };

  const clearStatus = () => {
    const status = statusRef.current;
    if (!status) return;
    status.hidden = true;
    status.textContent = "";
    status.removeAttribute("data-status-kind");
  };

  const showStatus = (kind: "success" | "error", message: string) => {
    const status = statusRef.current;
    if (!status) return;
    status.hidden = false;
    status.textContent = message;
    status.setAttribute("data-status-kind", kind);
    status.className =
      kind === "error"
        ? "font-mono text-[10px] text-rose-700 max-w-2xl leading-relaxed whitespace-normal break-words"
        : "font-mono text-[10px] text-emerald-700 max-w-2xl leading-relaxed whitespace-normal break-words";
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(
      clearStatus,
      kind === "success" ? SUCCESS_TOAST_TIMEOUT_MS : ERROR_TOAST_TIMEOUT_MS,
    );
  };

  const handleClick = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingUi(true);
    clearStatus();
    if (openMissingRef.current) openMissingRef.current.hidden = true;
    launchRigCmux({ rigId })
      .then((result) => {
        const workspaceCount = result.workspaces.length;
        const agentCount = result.workspaces.reduce((sum, w) => sum + w.agents.length, 0);
        const names = result.workspaces.map((w) => w.name).join(", ");
        const missingSeats = result.missing ?? [];
        if (missingSeats.length > 0) {
          const missingNames = missingSeats.map((m) => `${m.logicalId} (${m.reason})`).join(", ");
          showStatus(
            "error",
            `已打开 ${agentCount}/${agentCount + missingSeats.length} 个席位。缺失：${missingNames}`,
          );
          lastMissingRef.current = missingSeats.map((m) => m.logicalId);
          if (openMissingRef.current) {
            openMissingRef.current.hidden = false;
          }
        } else {
          showStatus(
            "success",
            workspaceCount === 1
              ? `已启动 cmux 工作区“${names}”，含 ${agentCount} 个智能体。`
              : `已启动 ${workspaceCount} 个 cmux 工作区（${names}），共 ${agentCount} 个智能体。`,
          );
        }
      })
      .catch((err: Error) => {
        showStatus("error", err.message);
      })
      .finally(() => {
        inFlightRef.current = false;
        setPendingUi(false);
      });
  };

  return (
    <div
      data-testid="launch-cmux-wrapper"
      className="hidden lg:inline-flex items-center gap-3 ml-auto"
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="launch-cmux-button"
        onClick={handleClick}
        className="border border-on-surface bg-surface-lowest px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface hover:bg-surface-low disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-outline"
      >
        在 CMUX 中启动
      </button>
      <button
        ref={openMissingRef}
        type="button"
        hidden
        data-testid="open-missing-button"
        onClick={() => {
          const ids = lastMissingRef.current;
          if (ids.length === 0) return;
          if (openMissingRef.current) openMissingRef.current.disabled = true;
          Promise.allSettled(
            ids.map(async (logicalId) => {
              try {
                const result = await postOpenCmux({ rigId, logicalId });
                return { ok: result.ok === true };
              } catch {
                return { ok: false };
              }
            }),
          ).then((results) => {
            const opened = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ ok: boolean }>).value.ok).length;
            const failed = ids.length - opened;
            if (failed > 0) {
              showStatus("error", `已打开 ${opened}/${ids.length} 个缺失席位；${failed} 个仍不可用。`);
            } else {
              showStatus("success", `已打开 ${opened} 个缺失席位。`);
              if (openMissingRef.current) openMissingRef.current.hidden = true;
            }
            if (openMissingRef.current) openMissingRef.current.disabled = false;
          });
        }}
        className="border border-on-surface bg-surface-lowest px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface hover:bg-surface-low disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-outline"
      >
        打开缺失席位
      </button>
      <span
        ref={statusRef}
        hidden
        data-testid="launch-cmux-status"
        role="status"
        aria-live="polite"
        className="font-mono text-[10px] text-emerald-700 max-w-2xl leading-relaxed whitespace-normal break-words"
      />
    </div>
  );
}
