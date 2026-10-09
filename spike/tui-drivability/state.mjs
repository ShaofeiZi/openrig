// 每个实例只有一份视图状态，并且只有一个变更入口（dispatch）——PIN 1。
// 本文件不包含任何模块级状态（FR-13）。section 集合是数据注册表，而不是
// switch（FR-12）：每项 = {name, sourceRead, drillShape}。
import { STUB, findAgent, findSpec, findRig, findHost, agentsRunningSpec } from './data.mjs'

export function defaultSections() {
  return [
    { name: 'topology', sourceRead: 'GET /api/rigs/:id/graph + /api/ps + /api/rigs/summary (existing)', drillShape: 'host>rig>pod>agent' },
    { name: 'specs', sourceRead: 'GET /api/specs/library + /api/rigs/:rigId/spec (existing)', drillShape: 'kind>spec' },
    { name: 'needs', sourceRead: 'GET /api/review/rig|fleet + /api/queue/list?attention=1 (existing)', drillShape: 'flat' },
  ]
}

export function createViewState({ instanceId, sections = defaultSections() } = {}) {
  if (!instanceId) throw new Error('createViewState 需要 instanceId（A2：实例必须可寻址）')

  let state = {
    instanceId,
    sections,
    section: sections[0]?.name ?? 'topology',
    drill: [],
    filter: '',
    selection: 0,
    runningOf: null,
    lastError: null,
  }
  const listeners = new Set()

  function get() {
    return state
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // 唯一状态变更路径。所有适配器（命令栏、鼠标、键盘、control socket）
  // 最终都进入这里；其他位置都不能写状态。
  function dispatch(action) {
    state = reduce(state, action)
    for (const fn of listeners) fn(state)
    return state
  }

  return { instanceId, get, dispatch, subscribe }
}

function reduce(state, action) {
  const next = { ...state, lastError: null }
  switch (action.type) {
    case 'noop':
      return next
    case 'error':
      return { ...next, lastError: action.message }
    case 'jump': {
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `未知区域 "${action.section}"` }
      return { ...next, section: action.section, drill: [], filter: '', selection: 0, runningOf: null }
    }
    case 'filter':
      return { ...next, filter: action.text, selection: 0 }
    case 'select': {
      const count = Math.max(action.rowCount ?? Number.MAX_SAFE_INTEGER, 1)
      const target = action.index ?? state.selection + (action.delta ?? 0)
      return { ...next, selection: Math.min(Math.max(target, 0), count - 1) }
    }
    case 'activate': {
      // Enter 激活选中的资源浏览器行；解析所用模型与 renderer 绘制的是同一个，
      // 因此键盘和鼠标路径不会产生分歧。
      const rows = computeExplorerRows(state)
      const row = rows[state.selection]
      if (!row) return { ...next, lastError: '未选择任何内容' }
      return reduce(next, row.action)
    }
    case 'drill':
      return drillTo(next, action)
    case 'cross':
      return crossNav(next, action)
    default:
      return { ...next, lastError: `未知操作 "${action.type}"` }
  }
}

function drillTo(state, { resource, name }) {
  switch (resource) {
    case 'host': {
      const found = findHost(name)
      if (!found) return { ...state, lastError: `主机不存在："${name}"` }
      return { ...state, section: 'topology', drill: [{ kind: 'host', name }], selection: 0, runningOf: null }
    }
    case 'rig': {
      const found = findRig(name)
      if (!found) return { ...state, lastError: `工作组不存在："${name}"` }
      return { ...state, section: 'topology', drill: [{ kind: 'host', name: found.host.name }, { kind: 'rig', name }], selection: 0, runningOf: null }
    }
    case 'pod': {
      for (const host of STUB.hosts)
        for (const rig of host.rigs)
          if (rig.pods.some((p) => p.name === name))
            return { ...state, section: 'topology', drill: [{ kind: 'host', name: host.name }, { kind: 'rig', name: rig.name }, { kind: 'pod', name }], selection: 0, runningOf: null }
      return { ...state, lastError: `pod 不存在："${name}"` }
    }
    case 'agent': {
      const found = findAgent(name)
      if (!found) return { ...state, lastError: `智能体不存在："${name}"` }
      return {
        ...state,
        section: 'topology',
        drill: [
          { kind: 'host', name: found.host.name },
          { kind: 'rig', name: found.rig.name },
          { kind: 'pod', name: found.pod.name },
          { kind: 'agent', name },
        ],
        selection: 0,
        runningOf: null,
      }
    }
    case 'spec': {
      const found = findSpec(name)
      if (!found) return { ...state, lastError: `spec 不存在："${name}"` }
      return { ...state, section: 'specs', drill: [{ kind: 'spec', name }], selection: 0, runningOf: null }
    }
    default:
      return { ...state, lastError: `未知资源 "${resource}"` }
  }
}

// 资源浏览器行模型是 state 的纯函数，由 reducer（'activate'）和 renderer
//（绘制 + hit-map）共享，因此只有一个事实来源。
export function computeExplorerRows(state) {
  const rows = []
  for (const section of state.sections) {
    const active = section.name === state.section
    const label = { topology: '拓扑', specs: 'SPEC', needs: '需要你处理' }[section.name] ?? section.name.toUpperCase()
    rows.push({ label: `${active ? '▾' : '▸'} ${label}`, action: { type: 'jump', section: section.name } })
    if (!active) continue
    if (section.name === 'topology') {
      for (const host of STUB.hosts) {
        rows.push({ label: `  ▾ ${host.name}${host.reachable ? '' : '（不可达）'}`, action: { type: 'drill', resource: 'host', name: host.name } })
        for (const rig of host.rigs) {
          rows.push({ label: `    ▾ ${rig.name}`, action: { type: 'drill', resource: 'rig', name: rig.name } })
          for (const pod of rig.pods) {
            rows.push({ label: `      ▾ ${pod.name} (${pod.agents.length})`, action: { type: 'drill', resource: 'pod', name: pod.name } })
            for (const agent of pod.agents)
              rows.push({ label: `        ● ${agent.name}`, action: { type: 'drill', resource: 'agent', name: agent.name } })
          }
        }
      }
    } else if (section.name === 'specs') {
      for (const [kind, list] of Object.entries(STUB.specs)) {
        rows.push({ label: `  ${kind.toUpperCase()} SPECS (${list.length})`, action: { type: 'jump', section: 'specs' } })
        for (const spec of list) rows.push({ label: `    ▪ ${spec.name}`, action: { type: 'drill', resource: 'spec', name: spec.name } })
      }
    } else if (section.name === 'needs') {
      for (const item of STUB.needs) rows.push({ label: `  ⚑ ${item.kind}: ${item.target}`, action: { type: 'jump', section: 'needs' } })
    }
  }
  return rows
}

function crossNav(state, { kind, name }) {
  if (kind === 'spec-of') {
    const found = findAgent(name)
    if (!found) return { ...state, lastError: `智能体不存在："${name}"` }
    return { ...state, section: 'specs', drill: [{ kind: 'spec', name: found.agent.spec }], selection: 0, runningOf: null }
  }
  if (kind === 'running') {
    const spec = findSpec(name)
    if (!spec) return { ...state, lastError: `spec 不存在："${name}"` }
    const seats = agentsRunningSpec(name)
    return { ...state, section: 'topology', drill: [], runningOf: name, filter: '', selection: 0, seats }
  }
  return { ...state, lastError: `未知跨视图导航 "${kind}"` }
}
