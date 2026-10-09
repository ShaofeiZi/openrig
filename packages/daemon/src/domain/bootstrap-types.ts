/** Bootstrap 运行状态的生命周期。 */
export type BootstrapStatus = "planned" | "running" | "completed" | "failed" | "partial";

/** Bootstrap 操作类型。 */
export type ActionKind =
  | "runtime_check"
  | "requirement_check"
  | "external_install"
  | "package_install"
  | "rig_import"
  | "launch";

/** Bootstrap 操作状态的生命周期。 */
export type ActionStatus = "planned" | "approved" | "skipped" | "running" | "completed" | "failed";

/** 运行时验证状态。 */
export type RuntimeStatus = "verified" | "not_found" | "degraded" | "error";

/** 一次 Bootstrap 运行，即执行一次 `zrig bootstrap <spec>`。 */
export interface BootstrapRun {
  id: string;
  sourceKind: string;
  sourceRef: string;
  status: BootstrapStatus;
  rigId: string | null;
  createdAt: string;
  appliedAt: string | null;
}

/** Bootstrap 运行中的单个操作。 */
export interface BootstrapAction {
  id: string;
  bootstrapId: string;
  seq: number;
  actionKind: ActionKind;
  subjectType: string | null;
  subjectName: string | null;
  provider: string | null;
  commandPreview: string | null;
  status: ActionStatus;
  detailJson: string | null;
  createdAt: string;
}

/** 一条运行时验证记录。 */
export interface RuntimeVerification {
  id: string;
  runtime: string;
  version: string | null;
  capabilitiesJson: string | null;
  verifiedAt: string;
  status: RuntimeStatus;
  error: string | null;
}
