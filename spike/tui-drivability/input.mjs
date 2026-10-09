// 键盘与鼠标字节解码。鼠标使用 xterm SGR（1006）报告格式：
// ESC [ < b ; x ; y M/m——这是 tmux/iTerm/Terminal.app 的标准鼠标编码。
// decodeInput 返回带类型的事件；调用方根据 renderer 的 hit-map 解析鼠标事件，
// 再通过同一个 dispatch 派发。

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

export function decodeInput(bytes) {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8')
  const events = []
  let rest = text

  // 先提取 SGR 鼠标序列。
  rest = rest.replace(SGR_MOUSE, (_, b, x, y, kind) => {
    const button = Number(b)
    if (kind === 'M' && (button & 3) !== 3 && button < 32) {
      // 按下 0/1/2 号按钮（32+ 是移动/滚轮事件，此 spike 忽略）。
      events.push({ type: 'mouse', button: button & 3, x: Number(x), y: Number(y) })
    }
    return ''
  })

  // 键盘：一张精简解码表——方向键、Enter、Backspace、Escape 和可打印字符。
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]
    if (ch === '\x1b' && rest[i + 1] === '[') {
      const code = rest[i + 2]
      const key = { A: 'up', B: 'down', C: 'right', D: 'left' }[code]
      if (key) {
        events.push({ type: 'key', key, action: { type: 'select', delta: key === 'down' ? 1 : key === 'up' ? -1 : 0 } })
        i += 3
        continue
      }
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      events.push({ type: 'key', key: 'enter', action: { type: 'activate' } })
      i += 1
      continue
    }
    if (ch === '\x7f' || ch === '\b') {
      events.push({ type: 'key', key: 'backspace' })
      i += 1
      continue
    }
    if (ch === '\x1b') {
      events.push({ type: 'key', key: 'escape' })
      i += 1
      continue
    }
    if (ch >= ' ') events.push({ type: 'char', ch })
    i += 1
  }
  return events
}

// 测试/自动化辅助函数：构造终端在 (x, y) 按下鼠标左键时发出的 SGR 字节；
// 终端坐标从 1 开始。
export function sgrClick(x, y) {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`
}

export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h'
export const MOUSE_DISABLE = '\x1b[?1006l\x1b[?1000l'
export const ALT_SCREEN_ON = '\x1b[?1049h\x1b[?25l'
export const ALT_SCREEN_OFF = '\x1b[?25h\x1b[?1049l'
