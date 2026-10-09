// 故障诊断 shell 布局重做（裁决 3c6c2be0）——台账驱动的资源管理器模型。后台服务停止时
// 资源管理器侧边栏保持存在，但从同一个单 JSON 故障诊断发现（工作组+席位——
// 绝不走第二个读取路径）喂数据，并诚实标记为台账来源。面板内分割的左列
// 渲染这些行 + 诚实注释；恢复时 shell 将此来源切换为实时导航器。
export interface LedgerExplorerRow {
  label: string;
  rigName: string;
  seatCount: number;
}

export interface LedgerExplorer {
  /** 此处始终为 true——此侧边栏从台账（故障诊断单 JSON）喂数据，而非后台服务。 */
  ledgerSourced: true;
  /** 侧边栏上显示的诚实标记（创建者的台账来源诚实要求）。 */
  note: string;
  rows: LedgerExplorerRow[];
}

/** 台账资源管理器读取的按工作组形状——故障诊断 MODEL 的 foundOnHost
 *  （从同一个单 JSON 发现构建，因此这不是第二次读取）。 */
export interface LedgerRigInput {
  name: string;
  seatCount: number;
}

/** 从模型的工作组构建台账驱动的资源管理器（同一个单 JSON——无第二次读取）。 */
export function buildLedgerExplorer(foundOnHost: LedgerRigInput[]): LedgerExplorer {
  return {
    ledgerSourced: true,
    note: "台账来源 · 后台服务已停止",
    rows: foundOnHost.map((r) => ({ label: `▦ ${r.name}`, rigName: r.name, seatCount: r.seatCount })),
  };
}
