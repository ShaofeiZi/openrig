// GHOST-STAGE (e)——规范 OccupantInvalidator 接缝。切换切片（SeatHandoverService.commit()）
// 通过此接口使即将退出的占用者按席位名称存储的状态失效，从而保证后继者不会继承这些状态。
// 切换期间，后继者会恢复到同一窗格并复用规范席位名
//（retiringSessionName === successorSessionName）。dev-driver 的切换文件导入此定义，
// 确保只有一种结构，不产生重复版本。
//
// 两类失效处理（见 (e) 枚举/契约产物）：
//   Class-A（内存压缩 map 1a-1f + 按名称索引的上下文 sidecar 2a）：按名称硬删除。
//     其安全性依赖时序——在后继者写入任何按名称索引的状态之前，于 commit() 内调用，
//     因而按名称删除恰好只会清除退出者的条目。（名称无法隔离退出者与后继者，因为二者
//     共用名称；真正形成隔离的是调用时机。）
//   Class-B（持久化 queue_items / watchdog_jobs，携带席位角色）：按名称删除会一并清除
//     后继者自己的合法角色条目，因此必须限定到 generation。这依赖占用者 generation 身份
//     （atom-B）。在提供 `retiringGeneration` 前，Class-B 会明确记录但不执行，绝不按名称删除。

export interface OccupantInvalidator {
  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void;
}

/** 默认失效器组合的依赖。采用结构类型，既便于测试注入替身，也避免与 enforcer /
 * context-usage 存储形成硬导入循环。 */
export interface OccupantInvalidatorDeps {
  enforcer: { invalidateOccupant(sessionName: string): void };
  contextUsage: { invalidateOccupantSidecar(sessionName: string): void };
  /** (e/Class-B) 持久化 watchdog_jobs 存储——切换时停止由退出 generation 注册的已武装任务
   *（幽灵问题即过期唤醒进入后继者上下文）。可选；缺失时跳过 watchdog 分支，绝不回退到按名称处理。 */
  watchdog?: { dropArmedByRegisteringGeneration(generationUuid: string): number };
  /** (e/Class-B) 持久化 queue_items 存储——由退出 generation 认领的进行中条目释放回 pending。
   * 绝不删除：角色工作是持久的，应由后继者重新认领。可选。 */
  queue?: { releaseClaimsByGeneration(generationUuid: string): number };
  log?: (msg: string) => void;
}

export class DefaultOccupantInvalidator implements OccupantInvalidator {
  constructor(private readonly deps: OccupantInvalidatorDeps) {}

  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void {
    const { retiringSessionName, retiringGeneration } = args;
    const log = this.deps.log ?? (() => {});

    // Class-A——按名称硬删除。安全性由时序保证：在后继者写入前于 commit() 中执行。
    this.deps.enforcer.invalidateOccupant(retiringSessionName);
    this.deps.contextUsage.invalidateOccupantSidecar(retiringSessionName);

    // Class-B——只允许限定到 generation，绝不能按名称处理。共享名称无法区分退出者和
    // 后继者；按名称删除会清除后继者自身仍有效的角色条目。
    if (retiringGeneration === undefined) {
      log(
        `[occupant-invalidator] "${retiringSessionName}" 的 Class-B（queue_items/watchdog_jobs）失效处理` +
          `等待 atom-B：未提供 occupant-generation，因此不会按名称处理（否则会清除后继者自身的` +
          `合法角色条目）。在 generation 身份落地前不执行任何操作。`,
      );
      return;
    }
    // atom-B 已存在 → 执行限定到 generation 的 Class-B 失效处理。
    // Watchdog (3b)：停止退出 generation 注册的所有已武装任务。典型问题是过期唤醒进入
    // 后继者上下文；后继者会自行重新武装。限定 generation 后，后继者在相同名称、当前
    // generation 下的已武装任务不会受影响。
    const stopped = this.deps.watchdog?.dropArmedByRegisteringGeneration(retiringGeneration) ?? 0;
    if (stopped > 0) {
      log(
        `[occupant-invalidator] Class-B：已停止退出 generation ${retiringGeneration}（席位 ` +
          `"${retiringSessionName}"）注册的 ${stopped} 个已武装 watchdog 任务；后继者会自行重新武装。`,
      );
    }
    // Queue_items (3a)：将退出 generation 认领的所有进行中条目释放回 pending，绝不删除。
    // 角色工作需要持久保存并由后继者重新认领；幽灵只存在于退出者的过期认领。通过认领者
    // generation 限定范围，后继者在复用名称、当前 generation 下的认领不会受影响。
    const released = this.deps.queue?.releaseClaimsByGeneration(retiringGeneration) ?? 0;
    if (released > 0) {
      log(
        `[occupant-invalidator] Class-B：已将退出 generation ${retiringGeneration}（席位 ` +
          `"${retiringSessionName}"）认领的 ${released} 个进行中队列条目释放回 pending；后继者将重新认领。`,
      );
    }
  }
}
