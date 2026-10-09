import { resolveWakeTarget, type WakeSessionRow, type WakeResolution } from "./wake-resolver.js";

export interface WakeResolveServiceDeps {
  /** 按从新到旧（id DESC）返回席位的 session 记录。启动时接入 sessions⋈nodes 查询，
   *  测试中可注入替代实现。 */
  listSessionsBySeat: (seat: string) => WakeSessionRow[];
}

/**
 * L3b——/api/wake-resolve 背后的轻量服务：获取席位的 session 记录，并委托给纯函数
 * resolveWakeTarget（裁定 A：根据已有 store 解析，否则拒绝并给出指引）。
 */
export class WakeResolveService {
  private readonly deps: WakeResolveServiceDeps;

  constructor(deps: WakeResolveServiceDeps) {
    this.deps = deps;
  }

  resolve(seat: string, generation?: number): WakeResolution {
    const rows = this.deps.listSessionsBySeat(seat);
    return resolveWakeTarget(rows, { seat, generation });
  }
}
