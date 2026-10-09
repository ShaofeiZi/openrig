// Slice 24 —— launchRigCmux。
//
// Promise 辅助函数，POST 到 /api/rigs/:rigId/cmux/launch
// （slice 24 检查点 C 交付的新后台服务端点）。成功时返回后台服务响应中的
// workspaces 数组；4xx/5xx 时抛出携带后台服务诚实三段式消息的 Error。
//
// 区别于 useCmuxLaunch.ts——后者针对单个节点的
// open-or-focus 端点 POST /api/rigs/:rigId/nodes/:logicalId/open-cmux。

export interface RigCmuxLaunchInput {
  rigId: string;
}

export interface CmuxLaunchedWorkspace {
  name: string;
  agents: string[];
  blanks: number;
}

export interface MissingSeat {
  logicalId: string;
  reason: string;
}

export interface RigCmuxLaunchSuccess {
  ok: true;
  workspaces: CmuxLaunchedWorkspace[];
  missing?: MissingSeat[];
}

interface RigCmuxLaunchErrorBody {
  error: string;
  message: string;
  partial?: CmuxLaunchedWorkspace[];
}

export async function launchRigCmux({ rigId }: RigCmuxLaunchInput): Promise<RigCmuxLaunchSuccess> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/cmux/launch`, {
    method: "POST",
  });
  if (!res.ok) {
    let body: RigCmuxLaunchErrorBody | null = null;
    try {
      body = (await res.json()) as RigCmuxLaunchErrorBody;
    } catch {
      // 继续向下（用兜底消息）
    }
    const message = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as RigCmuxLaunchSuccess;
}
