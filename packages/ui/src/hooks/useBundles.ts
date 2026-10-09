import { useMutation } from "@tanstack/react-query";

/** 第 1 项 / slice-05：由 /api/bundles/inspect 呈现的来源元数据；v1 和 v2 路由均采用 camelCase 契约。 */
export interface InspectProvenance {
  createdAt?: string;
  sourceHost?: string;
  authorSession?: string;
  sourceRigId?: string;
  sourceRigName?: string;
  daemonVersion?: string;
  cliVersion?: string;
  notes?: string;
}

/** 第 2 项 / slice-05：由 /api/bundles/inspect 呈现的兼容性块，采用 camelCase 契约。 */
export interface InspectCompatibility {
  minDaemonVersion?: string;
  minCliVersion?: string;
  schemaVersion?: number;
}

export interface InspectResult {
  manifest: {
    name: string;
    version: string;
    rigSpec: string;
    schemaVersion?: number;
    packages?: Array<{ name: string; version: string; path: string }>;
    agents?: Array<{ name: string; version: string; path: string }>;
    /** 第 1 项来源块（包携带时）。 */
    provenance?: InspectProvenance;
    /** 第 2 项兼容性块（包携带时）。 */
    compatibility?: InspectCompatibility;
  };
  digestValid: boolean;
  integrityResult: { passed: boolean; mismatches: string[]; missing: string[]; extra: string[]; errors: string[] };
}

export interface BundleInstallResult {
  runId: string;
  status: string;
  rigId?: string;
  stages: Array<{ stage: string; status: string; detail?: { source?: string; [key: string]: unknown } }>;
  errors: string[];
}

export function useBundleInspect() {
  return useMutation<InspectResult, Error, { bundlePath: string }>({
    mutationFn: async ({ bundlePath }) => {
      const res = await fetch("/api/bundles/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return data as InspectResult;
    },
  });
}

export function useBundleInstall() {
  return useMutation<BundleInstallResult, Error, { bundlePath: string; plan?: boolean; autoApprove?: boolean; targetRoot?: string }>({
    mutationFn: async ({ bundlePath, plan, autoApprove, targetRoot }) => {
      const res = await fetch("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan, autoApprove, targetRoot }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
  });
}
