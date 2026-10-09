import { loadHumanRegistry, resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { SettingsStore } from "./user-settings/settings-store.js";

export class WorkflowHumanDestinationError extends Error {
  readonly code = "workflow_human_destination_unavailable";
  constructor(public readonly details: { state: string; [key: string]: unknown }, message: string) {
    super(message);
    this.name = "WorkflowHumanDestinationError";
  }
}

/** 现有操作员选择，仅在需要人工时重新解析。 */
export function resolveWorkflowHumanDestination(
  configured: () => unknown = () => new SettingsStore().resolveOne("workspace.operator_seat_name").value,
  registry: () => LoadResult = loadHumanRegistry,
): string {
  let selected: unknown;
  let loaded: LoadResult;
  try {
    selected = configured();
    loaded = registry();
  } catch (error) {
    throw new WorkflowHumanDestinationError({ state: "unavailable" },
      `Workflow 人工选择不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!loaded.ok) {
    throw new WorkflowHumanDestinationError({ state: "registry-unavailable" }, loaded.error);
  }
  const addresses = loaded.entities.map((human) => human.address);
  if (typeof selected === "string" && selected.trim()) {
    const address = resolveRegisteredHumanAddress(selected.trim(), loaded.entities);
    if (address) return address;
    throw new WorkflowHumanDestinationError({ state: "unregistered", selected, addresses },
      "workspace.operator_seat_name 未选择已注册 human。请检查 zrig gateway human list --json，并选择目标注册地址。");
  }
  if (addresses.length === 1) return addresses[0]!;
  throw new WorkflowHumanDestinationError({ state: addresses.length ? "ambiguous" : "missing", addresses },
    "Workflow 人工 fallback 需要一名已注册 human。请检查 zrig gateway human list --json；存在多名时显式选择 workspace.operator_seat_name。未虚构任何人工目标。");
}

/** 显式注入的目标仍可供嵌入方和隔离 fixture 使用。 */
export type WorkflowHumanDestination = string | (() => string);
export function workflowHumanDestination(selection: WorkflowHumanDestination = resolveWorkflowHumanDestination): string {
  return typeof selection === "function" ? selection() : selection;
}
