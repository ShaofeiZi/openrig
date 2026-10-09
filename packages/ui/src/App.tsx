import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { router } from "./routes.js";

export const UI_MAINTENANCE_NOTICE_STORAGE_KEY = "openrig.uiMaintenanceNoticeDismissed";

// zrig 界面处于实验性维护阶段的提示文案；localStorage 键为机器标识，保持不变。
const UI_MAINTENANCE_NOTICE =
  "zrig 界面为实验性项目，目前处于维护模式，不再积极开发；支持以尽力而为为原则。命令行（CLI）才是官方主推的使用界面。欢迎贡献。";

function wasMaintenanceNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function UiMaintenanceNotice() {
  const [dismissed, setDismissed] = useState(wasMaintenanceNoticeDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(UI_MAINTENANCE_NOTICE_STORAGE_KEY, "1");
    } catch {
      // localStorage 可能不可用；本次加载仍可正常关闭提示。
    }
    setDismissed(true);
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] flex items-start justify-between gap-3 border-b border-amber-500/40 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-50"
      data-testid="ui-maintenance-notice"
      role="status"
    >
      <span>{UI_MAINTENANCE_NOTICE}</span>
      <button
        aria-label="关闭维护提示"
        className="shrink-0 rounded px-1.5 font-semibold hover:bg-amber-200/60 dark:hover:bg-amber-900"
        onClick={dismiss}
        type="button"
      >
        ×
      </button>
    </div>
  );
}

export function App() {
  return (
    <>
      <UiMaintenanceNotice />
      <RouterProvider router={router} />
    </>
  );
}
