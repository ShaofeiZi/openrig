// OPR.0.4.1.14 —— 仪表盘"字段环境"使用的运行中后台服务版本。
//
// 封装 GET /api/health-summary/version，这是对后台服务自身 package.json 的无依赖读取。
// 这是正在为 UI 提供服务的后台服务的真实运行版本——刻意不用 UI 打包产物的构建期版本，
// 否则一旦安装的后台服务与 UI 不一致就会悄悄漂移。消费方在加载中或拉取失败时
// 诚实回退显示。

import { useQuery } from "@tanstack/react-query";

export interface DaemonVersionPayload {
  version: string;
}

async function fetchDaemonVersion(): Promise<DaemonVersionPayload> {
  const res = await fetch("/api/health-summary/version");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DaemonVersionPayload;
}

export function useDaemonVersion() {
  return useQuery({
    queryKey: ["health-summary", "version"],
    queryFn: fetchDaemonVersion,
    // 后台服务版本在其进程生命周期内固定；会话内无需重新拉取。
    staleTime: Infinity,
  });
}
