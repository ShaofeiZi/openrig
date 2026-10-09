// OPR.0.4.6.MH1 FR-5 —— 仪表盘主机配置数据层。
//
// 读：走 GET /api/hosts（仅指针的行 + 选中标记 + 粗粒度状态——
// 是 `rig host ls --json` 的后台服务侧兄弟接口）。
// 写：走窄命名的 add/pair 路由族（arch P1），带 mission-control bearer 姿态；
// 切换器与重命名刻意不放在这里——它们是普通设置写入
// （host.selected / host.name，经 useSetSetting → POST /api/config/:key），
// 是两个界面收敛到的同一条写路径。

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { missionControlAuthHeaders } from "../components/mission-control/missionControlAuth.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";

export interface HostRow {
  id: string;
  transport: "ssh" | "http";
  target?: string;
  url?: string;
  bearer_env?: string;
  bearer_file?: string;
  notes?: string;
  selected: boolean;
  status: "reachable" | "unreachable" | "unknown";
}

export interface HostsResponse {
  ownName: string;
  selected: string;
  hosts: HostRow[];
}

async function fetchHosts(): Promise<HostsResponse> {
  const res = await fetch("/api/hosts");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as HostsResponse;
}

export function useHosts() {
  return useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: fetchHosts,
    refetchInterval: 5_000,
  });
}

// OPR.0.4.6.MH2 FR-1/FR-3 —— 全应用唯一的选择状态源。
// `["hosts"]` 缓存项（由常驻挂载的 HostIndicator + 经 useHosts 的 explorer 树轮询）
// 携带与 CLI 写入相同的 `host.selected` 配置键，因此指示器与数据来自单一状态源：
// 每个读 hook 都以该值为键，从结构上排除了 k9s 那种
// 「标签是 A、数据是 B」的过期表头类问题。
//
// 缓存观察者，刻意不自己发请求（enabled: false）：本 hook 搭载在全部七个读 hook 内部，
// 若每个消费者都发请求，会给每个界面都加一次 /api/hosts 调用——破坏所有
// 顺序 fetch mock 测试，并徒增轮询却不带来任何信息
//（活跃的 useHosts 观察者在每个真实屏幕上都让该缓存项保持温热）。
// 无缓存 ⇒ 本地——这是安全/诚实的首屏渲染。
export function useSelectedHostId(): string {
  const { data } = useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: fetchHosts,
    enabled: false,
  });
  return data?.selected ?? LOCAL_HOST_ID;
}

/** OPR.0.4.6.MH2 guard-B1——依赖本地文件系统界面共享的主机选择状态：`known` 表示
 * 主机载荷已返回，`isLocal` 表示选中本地主机。!known 时组件渲染加载状态，绝不提前显示
 * 远程门控文案，避免本地冷启动时误闪；只有明确知道是远程选择时才显示门控文案。
 *
 * 它是活跃观察者，与 useSelectedHostId 不同；使用方是 BriefPanel、MissionGlance 等叶子面板，
 * 必须可独立正确工作。如果组件树中没有页面级 useHosts，禁用的观察者永远无法得知选择结果，
 * 会一直加载。应用内它通过相同的 ["hosts"] 键与页面轮询器去重；高扇出的只读 hook 继续使用
 * 禁用观察者模式，因为它们始终渲染在活跃页面下。 */
export function useHostSelection(): { known: boolean; isLocal: boolean } {
  const { data } = useHosts();
  return { known: data !== undefined, isLocal: (data?.selected ?? LOCAL_HOST_ID) === LOCAL_HOST_ID };
}

/** OPR.0.4.6.MH2 guard-B1——本地文件系统读取唯一共享的获取守卫。/api/files/* 仅限本地，
 * 不参与读取透传。只有选择结果已知且为本地时才返回 true；若仅按非远程门控，首次渲染会产生
 * 竞态，在远程选择解析完成前发出假定本地的读取。所有文件界面都使用这个 hook，避免未来调用点
 * 再次错误推导守卫。 */
export function useLocalFilesAllowed(): boolean {
  const { known, isLocal } = useHostSelection();
  return known && isLocal;
}

/** OPR.0.4.6.MH2 rev1-r2 再次裁定 B1——发现放置目标会供给本地接纳变更；本地创建的目标
 * 不得跨越主机切换继续存在，否则远程标签下会出现陈旧但可操作的接纳动作。外壳以自身的
 * clearPlacement 调用此 hook，使任何选中主机变化都会清除陈旧目标和已发现会话选择，构成第一道
 * 保险；远程选择下，面板还会抑制目标/接纳 UI，构成第二道保险。 */
export function useClearPlacementOnHostSwitch(clear: () => void) {
  const hostId = useSelectedHostId();
  const prev = useRef(hostId);
  useEffect(() => {
    if (prev.current !== hostId) {
      prev.current = hostId;
      clear();
    }
  }, [hostId, clear]);
}

/** 选择写入：与 CLI 使用同一条写路径，`rig host select` 只是
 * POST /api/config/host.selected 的薄客户端。使 hosts 查询失效，让指示器和所有按主机定键的读取
 * 立即切换目标，无须等待 5 秒轮询。 */
export function useSelectHost() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { hostId: string }>({
    mutationFn: async ({ hostId }) => {
      const res = await fetch(`/api/config/${encodeURIComponent("host.selected")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: hostId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface PairStart {
  pairId: string;
  code: string;
  target: string;
}

export function usePairHost() {
  return useMutation<PairStart, Error, { url: string; id?: string }>({
    mutationFn: async (input) => {
      const res = await fetch("/api/hosts/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => ({}))) as PairStart & { error?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      return body;
    },
  });
}

export interface PairPollResult {
  status: "pending" | "approved" | "denied" | "expired";
  code?: string;
  entry?: HostRow;
}

/** 配对有效期间，轮询本地后台服务的透传配对支路。传入 null 可让 hook 空闲，不发请求。 */
export function usePairPoll(pairId: string | null) {
  const qc = useQueryClient();
  return useQuery<PairPollResult>({
    queryKey: ["hosts-pair", pairId],
    enabled: pairId !== null,
    queryFn: async () => {
      const res = await fetch(`/api/hosts/pair/${pairId}`, {
        headers: { ...missionControlAuthHeaders() },
      });
      const body = (await res.json().catch(() => ({}))) as PairPollResult & { error?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      if (body.status === "approved") void qc.invalidateQueries({ queryKey: ["hosts"] });
      return body;
    },
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === undefined || s === "pending" ? 2_000 : false;
    },
  });
}
