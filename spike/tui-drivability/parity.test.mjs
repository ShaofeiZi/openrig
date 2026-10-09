import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewState } from './state.mjs'
import { parseCommand } from './grammar.mjs'
import { decodeInput, sgrClick } from './input.mjs'
import { displayWidth, renderScreen, sliceByColumns } from './render.mjs'

// PIN 1：命令 / 鼠标 / 键盘是同一 dispatch 上的三种适配器。
// 三类输入抵达完全相同的状态，即证明了行为对齐。

function freshPair() {
  return [createViewState({ instanceId: 'cmd' }), createViewState({ instanceId: 'ui' })]
}

function comparable(state) {
  const { instanceId, sections, ...rest } = state
  return rest
}

test('命令与 Explorer 鼠标点击抵达相同状态', () => {
  const [byCommand, byMouse] = freshPair()

  byCommand.dispatch(parseCommand(':specs'))

  // 渲染 byMouse 的屏幕，找到“specs”的 Explorer 点击目标，再点击其坐标。
  const screen = renderScreen(byMouse.get(), { cols: 100, rows: 30 })
  const target = screen.hitMap.find((h) => h.action.type === 'jump' && h.action.section === 'specs')
  assert.ok(target, 'Explorer 必须为 specs 区域提供可点击目标')
  const events = decodeInput(sgrClick(target.x1, target.y))
  const click = events.find((e) => e.type === 'mouse')
  assert.ok(click, 'SGR 鼠标字节必须解码为鼠标事件')
  const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2)
  byMouse.dispatch(hit.action)

  assert.deepEqual(comparable(byMouse.get()), comparable(byCommand.get()))
})

test('命令与键盘（方向键 + Enter）抵达相同状态', () => {
  const [byCommand, byKeys] = freshPair()

  byCommand.dispatch(parseCommand('rig openrig-build'))

  // 键盘路径：Explorer 从 topology/host 开始；按 ArrowDown 移到工作组行，再按 Enter 下钻。
  const screen = renderScreen(byKeys.get(), { cols: 100, rows: 30 })
  const rigIndex = screen.explorerRows.findIndex((r) => r.action.type === 'drill' && r.action.resource === 'rig')
  assert.ok(rigIndex >= 0, 'Explorer 必须列出工作组行')
  for (let i = 0; i < rigIndex; i++) {
    for (const e of decodeInput('[B')) byKeys.dispatch(e.action ?? e) // ArrowDown
  }
  const enter = decodeInput('\r')[0]
  byKeys.dispatch(enter.action ?? enter)

  assert.deepEqual(comparable(byKeys.get()), comparable(byCommand.get()))
})

test('对齐表格使用固定宽度列并让数值右对齐', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch(parseCommand('rig openrig-build'))
  const screen = renderScreen(s.get(), { cols: 100, rows: 30 })
  const header = screen.lines.find((l) => l.includes('智能体') && l.includes('状态'))
  assert.ok(header, '智能体表格标题应完成渲染')
  const ctxCol = displayWidth(header.slice(0, header.indexOf('CTX%')))
  const rows = screen.lines.filter((l) => /(运行中|空闲|需关注|未知)/.test(l))
  assert.ok(rows.length >= 2, '应渲染智能体行')
  for (const row of rows) {
    // 右对齐数值：数字结束位置与 CTX% 标题结束位置相同。
    const cell = sliceByColumns(row, ctxCol, 4)
    assert.match(cell, /^\s*(\d+%|—)$/, `CTX% 单元格应右对齐；在 "${row}" 中得到 "${cell}"`)
  }
})

test('中文可见文本按终端列宽计算', () => {
  assert.equal(displayWidth('智能体'), 6)
  const view = createViewState({ instanceId: '中文' })
  const screen = renderScreen(view.get(), { cols: 100, rows: 30 })
  assert.ok(screen.lines.some((line) => line.includes('智能体') && line.includes('状态')))
  assert.equal(displayWidth(screen.lines[0]), 100)
})
