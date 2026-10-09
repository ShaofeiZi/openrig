/** 创建者选择的 L2 资源管理器：终端的四分之一，有界以便
 *  树保持有用而不抢占工厂/任务目标画布。 */
export function explorerWidth(cols: number): number {
  return Math.max(24, Math.min(32, Math.round(cols * 0.25)));
}

/** MOT-03：有用的可见工作以每秒两帧动画。 */
export const MOTION_FRAME_MS = 500;
