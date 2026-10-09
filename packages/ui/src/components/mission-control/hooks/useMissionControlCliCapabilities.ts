// PL-005 A 阶段：获取机队 CLI 能力缓存的 hook（漂移指示器）。
import { useQuery } from "@tanstack/react-query";

export interface FleetRollupRow {
  rigName: string;
  activityState: "active" | "idle" | "attention" | "blocked" | "degraded";
  lifecycleState: string | null;
  attentionReason: string | null;
  lastUpdate: string;
  cliVersionLabel: string;
  cliDriftDetected: boolean;
}

export interface FleetRollup {
  rows: FleetRollupRow[];
  staleCliCount: number;
  degradedFields: string[];
  sourceFallback: string | null;
}

async function fetchCliCapabilities(): Promise<FleetRollup> {
  const res = await fetch("/api/mission-control/cli-capabilities");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMissionControlCliCapabilities() {
  return useQuery({
    queryKey: ["mission-control", "cli-capabilities"],
    queryFn: fetchCliCapabilities,
    refetchInterval: 30_000,
  });
}
