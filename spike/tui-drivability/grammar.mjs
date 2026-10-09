// 安全核心命令语法（§4.B / FR-1）：:section 跳转 · /text 过滤 ·
// <resource> <name> 下钻 · spec-of / running 跨视图导航。分类体系以 k9s 为主。
// parseCommand 只负责 text -> action；目标是否存在由 dispatch 验证，
// 因而所有输入适配器共享同一个失败入口。

const SECTIONS = ['topology', 'specs', 'needs']
const RESOURCES = ['host', 'rig', 'pod', 'agent', 'spec']

export function parseCommand(raw) {
  const input = raw.trim()
  if (input === '') return { type: 'noop' }

  if (input.startsWith(':')) {
    const section = input.slice(1).trim()
    if (SECTIONS.includes(section)) return { type: 'jump', section }
    return { type: 'error', message: `未知区域 ":${section}"——已知区域：${SECTIONS.map((s) => ':' + s).join(' ')}` }
  }

  if (input.startsWith('/')) {
    return { type: 'filter', text: input.slice(1).trim() }
  }

  const [verb, ...rest] = input.split(/\s+/)
  const name = rest.join(' ')

  if (verb === 'spec-of' || verb === 'running') {
    if (!name) return { type: 'error', message: `${verb} 需要目标名称（例如 "${verb} ${verb === 'spec-of' ? 'dev50.driver' : 'driver-agent'}"）` }
    return { type: 'cross', kind: verb, name }
  }

  if (RESOURCES.includes(verb)) {
    if (!name) return { type: 'error', message: `${verb} 下钻需要名称（例如 "${verb} <name>"）` }
    return { type: 'drill', resource: verb, name }
  }

  return { type: 'error', message: `未知命令 "${verb}"——已知命令：:<section> /<filter> ${RESOURCES.join('|')} <name>, spec-of <agent>, running <spec>` }
}
