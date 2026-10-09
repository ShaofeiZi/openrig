// Preview Terminal v0（PL-018）—— 钉住预览 store。
//
// 按会话的 UI 状态（无后台服务往返）。依 PRD，v0 不含浏览器刷新后的钉住持久化；
// 这里仅用简单可订阅 store 存于内存（约 50 行无需引入 Zustand 依赖）。
//
// 上限：ui.preview.max_pins（默认 4）——在钉住时强制。

export interface PreviewPin {
  rigId: string;
  rigName: string;
  logicalId: string;
  sessionName: string;
}

type Listener = (pins: PreviewPin[]) => void;

class PreviewPinStore {
  private pins: PreviewPin[] = [];
  private listeners = new Set<Listener>();
  private maxPins = 4;

  setMaxPins(maxPins: number): void {
    this.maxPins = Math.max(1, Math.floor(maxPins));
    if (this.pins.length > this.maxPins) {
      this.pins = this.pins.slice(0, this.maxPins);
      this.notify();
    }
  }

  getMaxPins(): number {
    return this.maxPins;
  }

  list(): PreviewPin[] {
    return this.pins;
  }

  isPinned(rigId: string, logicalId: string): boolean {
    return this.pins.some((p) => p.rigId === rigId && p.logicalId === logicalId);
  }

  /**
   * 钉住一个席位。成功返回 true；将超出上限时返回 false（调用方据此给出 UI 提示）。
   */
  pin(pin: PreviewPin): boolean {
    if (this.isPinned(pin.rigId, pin.logicalId)) return true;
    if (this.pins.length >= this.maxPins) return false;
    this.pins = [...this.pins, pin];
    this.notify();
    return true;
  }

  unpin(rigId: string, logicalId: string): void {
    const next = this.pins.filter((p) => !(p.rigId === rigId && p.logicalId === logicalId));
    if (next.length !== this.pins.length) {
      this.pins = next;
      this.notify();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) l(this.pins);
  }
}

export const previewPinStore = new PreviewPinStore();
