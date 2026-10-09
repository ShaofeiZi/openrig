#!/usr/bin/env node
// 交互式 spike 运行壳。三个输入适配器（命令栏 / 鼠标 / 键盘）加一个可选的
// control-socket 适配器（--socket <path>），四者最终都进入同一实例级视图状态的
// 唯一 dispatch。
//
//   node harness.mjs [--instance tui-a] [--socket /path/ctl.sock]
//
// Control socket 协议（“可寻址屏幕 API”候选方案）：每行一条命令，可以是任意命令栏
// 命令，也可以是 "state"（JSON 状态查询）。每行都会得到一行 JSON 响应：
// {ok, screen, drill, error}。
import net from 'node:net'
import fs from 'node:fs'
import { createViewState, computeExplorerRows } from './state.mjs'
import { parseCommand } from './grammar.mjs'
import { decodeInput, MOUSE_ENABLE, MOUSE_DISABLE, ALT_SCREEN_ON, ALT_SCREEN_OFF } from './input.mjs'
import { renderScreen } from './render.mjs'

const args = process.argv.slice(2)
function argOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const instanceId = argOf('--instance') ?? 'tui-1'
const socketPath = argOf('--socket')

const view = createViewState({ instanceId })
let inputLine = ''
let lastScreen = null

function describe(state) {
  return {
    ok: !state.lastError,
    screen: state.section,
    drill: state.drill.map((d) => `${d.kind}:${d.name}`),
    filter: state.filter || undefined,
    error: state.lastError ?? undefined,
  }
}

function draw() {
  const { columns = 120, rows = 32 } = process.stdout
  lastScreen = renderScreen(view.get(), { cols: columns, rows }, inputLine)
  process.stdout.write('\x1b[H' + lastScreen.lines.map((l) => '\x1b[2K' + l).join('\r\n'))
}

function submitCommand(text) {
  view.dispatch(parseCommand(text))
}

// --- 键盘与鼠标适配器（stdin）---
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (bytes) => {
  for (const ev of decodeInput(bytes)) {
    if (ev.type === 'char') {
      if (ev.ch === 'q' && inputLine === '') return shutdown()
      inputLine += ev.ch
    } else if (ev.type === 'key' && ev.key === 'backspace') {
      inputLine = inputLine.slice(0, -1)
    } else if (ev.type === 'key' && ev.key === 'escape') {
      inputLine = ''
    } else if (ev.type === 'key' && ev.key === 'enter') {
      if (inputLine !== '') {
        submitCommand(inputLine)
        inputLine = ''
      } else {
        view.dispatch({ type: 'activate' })
      }
    } else if (ev.type === 'key' && ev.action) {
      view.dispatch({ ...ev.action, rowCount: computeExplorerRows(view.get()).length })
    } else if (ev.type === 'mouse' && lastScreen) {
      const hit = lastScreen.hitMap.find((h) => h.y === ev.y && ev.x >= h.x1 && ev.x <= h.x2)
      if (hit) view.dispatch(hit.action)
    }
  }
  draw()
})

// --- control-socket 适配器（更完整的机制原型）---
let server = null
if (socketPath) {
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
  server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        if (line === 'state') {
          conn.write(JSON.stringify({ ok: true, instanceId, state: describe(view.get()) }) + '\n')
        } else {
          submitCommand(line)
          conn.write(JSON.stringify(describe(view.get())) + '\n')
          draw()
        }
      }
    })
  })
  server.listen(socketPath)
}

function shutdown() {
  process.stdout.write(MOUSE_DISABLE + ALT_SCREEN_OFF)
  if (server) server.close()
  if (socketPath && fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.write(ALT_SCREEN_ON + MOUSE_ENABLE)
draw()
