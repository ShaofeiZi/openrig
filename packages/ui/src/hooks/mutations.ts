import { useMutation, useQueryClient } from "@tanstack/react-query";

export class ImportError extends Error {
  errors: string[];
  warnings: string[];
  code: string;

  constructor(data: { code?: string; errors?: string[]; warnings?: string[]; message?: string }) {
    const msg = data.errors?.join(", ") ?? data.message ?? "导入失败";
    super(msg);
    this.name = "ImportError";
    this.code = data.code ?? "unknown";
    this.errors = data.errors ?? (data.message ? [data.message] : ["导入失败"]);
    this.warnings = data.warnings ?? [];
  }
}

export class RestoreError extends Error {
  code: string;

  constructor(data: { code?: string; error?: string }, status: number) {
    super(data.error ?? `HTTP ${status}`);
    this.name = "RestoreError";
    this.code = data.code ?? "unknown";
  }
}

export function useCreateSnapshot(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `创建快照失败（HTTP ${res.status}）`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rig", rigId, "snapshots"] });
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}

export function useRestoreSnapshot(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (snapshotId: string) => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new RestoreError(data as { code?: string; error?: string }, res.status);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
    },
  });
}

export function useTeardownRig(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/down", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigId }),
      });
      const data = await res.json().catch(() => ({})) as {
        errors?: string[];
        error?: string;
        sessionsKilled?: number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `关闭工作组失败（HTTP ${res.status}）`);
      }
      // 由响应体判断：即使状态为 200，只要 errors[] 非空仍视为失败。
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw new Error(data.errors.join("; "));
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
    },
  });
}

export function useStartRig(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/up`, { method: "POST" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `启动失败（HTTP ${res.status}）`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
    },
  });
}

/**
 * OPR.0.4.3.22——启动/恢复弹窗在操作员看过只读计划后执行的、携带策略的变更。
 * 请求 POST /api/rigs/:id/up，并在显式请求体中携带 `freshLogicalIds`
 *（逐席位的全新启动列表——锁定规则：fresh 只能是逐席位列表，不能是全局开关）。
 *
 * 此变更与 `useStartRig` 不同；后者仍是无请求体的默认 `/up` POST。弹窗绝不经过
 * `useStartRig`，因此不会静默改变默认恢复行为（守卫 3）。
 */
export function useLaunchRig(rigId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (freshLogicalIds?: string[]) => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(freshLogicalIds && freshLogicalIds.length > 0 ? { freshLogicalIds } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        throw new RestoreError(data as { code?: string; error?: string }, res.status);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
      queryClient.invalidateQueries({ queryKey: ["kernel", "status"] });
    },
  });
}

export function useImportRig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ yaml, rigRoot }: { yaml: string; rigRoot?: string }) => {
      const headers: Record<string, string> = { "Content-Type": "text/yaml" };
      if (rigRoot) headers["X-Rig-Root"] = rigRoot;
      const res = await fetch("/api/rigs/import", {
        method: "POST",
        headers,
        body: yaml,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { code?: string; errors?: string[]; warnings?: string[]; message?: string };
        if (data.code === "cycle_error") {
          throw new ImportError({ ...data, errors: data.errors ?? ["工作组拓扑中检测到循环"] });
        }
        throw new ImportError(data);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
    },
  });
}

export interface ExpandRigResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podId?: string;
  podNamespace?: string;
  nodes?: Array<{ logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string }>;
  warnings?: string[];
  retryTargets?: string[];
  code?: string;
  error?: string;
}

export function useExpandRig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ rigId, pod, crossPodEdges }: { rigId: string; pod: Record<string, unknown>; crossPodEdges?: unknown[] }) => {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pod, crossPodEdges }),
      });
      const data = await res.json() as ExpandRigResult;
      if (res.status >= 400 || !data.ok) {
        throw new Error(data.error ?? `扩展工作组失败（HTTP ${res.status}）`);
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["rig", variables.rigId, "nodes"] });
      queryClient.invalidateQueries({ queryKey: ["rig", variables.rigId, "graph"] });
    },
  });
}

export function useRemoveLibrarySpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await fetch(`/api/specs/library/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `移除失败（HTTP ${res.status}）`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spec-library"] });
    },
  });
}

export function useRenameLibrarySpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, name }: { entryId: string; name: string }) => {
      const res = await fetch(`/api/specs/library/${encodeURIComponent(entryId)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `重命名失败（HTTP ${res.status}）`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spec-library"] });
    },
  });
}
