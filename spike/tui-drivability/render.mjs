// 手写 ANSI renderer（正在试验的 substrate 候选方案）。布局：
// 第 1 行命令栏 · 第 2 行分隔线 · 左侧 Explorer（固定宽度）· 右侧 Content
// 窗格 · 最后一行状态栏。返回纯文本行和 hit-map，使鼠标点击解析为与命令相同的语义操作。
import { computeExplorerRows } from './state.mjs'
import { STUB, findAgent, findSpec, agentsRunningSpec } from './data.mjs'

const EXPL_W = 30

// 中文等全角字符占两个终端列；按显示宽度补齐或截断，避免破坏列对齐。
function charWidth(char) {
  const code = char.codePointAt(0) ?? 0
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1
}

function fit(text, width) {
  let result = ''
  let columns = 0
  for (const char of String(text ?? '')) {
    const next = charWidth(char)
    if (columns + next > width) break
    result += char
    columns += next
  }
  return { text: result, columns }
}

function pad(text, width) {
  const fitted = fit(text, width)
  return fitted.text + ' '.repeat(width - fitted.columns)
}

function padLeft(text, width) {
  const fitted = fit(text, width)
  return ' '.repeat(width - fitted.columns) + fitted.text
}

const AGENT_COLS = [
  ['POD', 8, 'left'],
  ['智能体', 16, 'left'],
  ['运行时', 13, 'left'],
  ['CTX%', 4, 'right'],
  ['TOKENS', 7, 'right'],
  ['状态', 17, 'left'],
  ['操作', 14, 'left'],
]

function statusLabel(status) {
  return { running: '运行中', idle: '空闲', 'needs-attention': '需关注', unknown: '未知' }[status] ?? status
}

function needKindLabel(kind) {
  return { 'idle-with-work': '有任务但空闲', 'host-down': '主机离线' }[kind] ?? kind
}

export function displayWidth(text) {
  return [...String(text ?? '')].reduce((columns, char) => columns + charWidth(char), 0)
}

export function sliceByColumns(text, start, width) {
  let columns = 0
  let result = ''
  for (const char of String(text ?? '')) {
    const next = charWidth(char)
    if (columns + next <= start) { columns += next; continue }
    if (columns >= start + width || columns + next > start + width) break
    result += char
    columns += next
  }
  return result
}

function tableRow(cells) {
  return AGENT_COLS.map(([, w, align], i) => (align === 'right' ? padLeft(cells[i], w) : pad(cells[i], w))).join(' ')
}

function contentLines(state) {
  const lines = []
  if (state.section === 'topology') {
    if (state.runningOf) {
      lines.push(`正在运行 spec "${state.runningOf}" 的席位：`)
      for (const seat of agentsRunningSpec(state.runningOf)) lines.push(`  ● ${seat}  （打开：agent ${seat}）`)
      return lines
    }
    const leaf = state.drill.at(-1)
    if (leaf?.kind === 'agent') {
      const { agent, rig, pod } = findAgent(leaf.name)
      lines.push(`智能体 ${agent.name}`)
      lines.push(`  工作组 ${rig.name} · pod ${pod.name} · 运行时 ${agent.runtime}`)
      lines.push(`  spec ${agent.spec}  （打开：spec-of ${agent.name}）`)
      lines.push(`  状态 ${statusLabel(agent.status)}`)
      return lines
    }
    const rigName = state.drill.find((d) => d.kind === 'rig')?.name ?? STUB.hosts[0]?.rigs[0]?.name
    const podFilter = leaf?.kind === 'pod' ? leaf.name : null
    const rig = STUB.hosts.flatMap((h) => h.rigs).find((r) => r.name === rigName)
    if (!rig) return ['当前视图中没有工作组']
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })))
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter))
    lines.push(`[ 表格 ] 概览      工作组 ${rig.name}${podFilter ? ` · pod ${podFilter}` : ''}${state.filter ? ` · 筛选 "${state.filter}"` : ''}`)
    lines.push(tableRow(AGENT_COLS.map(([name]) => name)))
    lines.push('─'.repeat(AGENT_COLS.reduce((n, [, w]) => n + w + 1, -1)))
    for (const a of rows)
      lines.push(
        tableRow([
          a.pod,
          a.name,
          a.runtime,
          a.context == null ? '—' : `${a.context}%`,
          a.tokens ?? '—',
          statusLabel(a.status),
          '运行 ▸ · 终端',
        ]),
      )
    lines.push('')
    lines.push(`显示 ${rows.length}/${all.length} 个智能体`)
    return lines
  }
  if (state.section === 'specs') {
    const leaf = state.drill.at(-1)
    if (leaf?.kind === 'spec') {
      const spec = findSpec(leaf.name)
      if (spec?.agentRefs) {
        lines.push(`工作组 spec ${spec.name}   标签页：拓扑 [ 配置 ] yaml`)
        lines.push('  成员：')
        for (const ref of spec.agentRefs) lines.push(`    ▪ ${ref}  （打开：spec ${ref}）`)
      } else if (spec) {
        lines.push(`智能体 spec ${spec.name}`)
        lines.push(`  运行时 ${spec.runtime}`)
        lines.push(`  使用它的工作组：${spec.usedByRigs.join(', ')}`)
        lines.push(`  当前席位：${agentsRunningSpec(spec.name).join(', ') || '（无）'}  （打开：running ${spec.name}）`)
      }
      return lines
    }
    lines.push('SPEC 库')
    for (const [kind, list] of Object.entries(STUB.specs)) {
      const shown = list.filter((s) => !state.filter || s.name.includes(state.filter))
      lines.push(`  ${kind.toUpperCase()} (${shown.length})`)
      for (const s of shown) lines.push(`    ▪ ${s.name}`)
    }
    return lines
  }
  if (state.section === 'needs') {
    lines.push('需要你处理')
    for (const item of STUB.needs) lines.push(`  ⚑ ${needKindLabel(item.kind)}  ${item.target}  — ${item.detail}  （打开 ▸）`)
    lines.push('')
    lines.push('  人工队列：暂无项目（已证明为空——展示接入仍待完成）')
    return lines
  }
  return [`(${state.section})`]
}

export function renderScreen(state, { cols = 120, rows = 32 } = {}, inputLine = '') {
  const lines = []
  const hitMap = []
  lines.push(pad(`命令 ▸ ${inputLine}`, cols))
  lines.push('─'.repeat(cols))

  const explorer = computeExplorerRows(state)
  const content = contentLines(state)
  const bodyRows = Math.max(explorer.length, content.length)
  const explorerRows = []
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1 // 此行所在终端行号，从 1 开始。
    const row = explorer[i]
    const marker = i === state.selection && row ? '›' : ' '
    const left = pad(row ? `${marker}${row.label}` : '', EXPL_W)
    const right = content[i] ?? ''
    lines.push(`${left}│ ${right}`)
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action })
      explorerRows.push({ ...row, y })
    }
  }

  const drillPath = state.drill.map((d) => d.name).join(' → ')
  lines.push('─'.repeat(cols))
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? ' · ' + drillPath : ''}${state.lastError ? '  ✗ ' + state.lastError : ''}`,
      cols,
    ),
  )
  while (lines.length < rows) lines.push('')
  return { lines: lines.slice(0, rows), hitMap, explorerRows }
}
