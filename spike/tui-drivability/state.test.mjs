import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewState, defaultSections } from './state.mjs'
import { STUB } from './data.mjs'

test('视图状态限定在实例内：两个实例绝不共享状态（FR-13 反向 AC）', () => {
  const a = createViewState({ instanceId: 'tui-a' })
  const b = createViewState({ instanceId: 'tui-b' })
  a.dispatch({ type: 'jump', section: 'specs' })
  assert.equal(a.get().section, 'specs')
  assert.equal(b.get().section, 'topology', '实例 a 的变更不得影响实例 b')
  assert.equal(a.get().instanceId, 'tui-a')
  assert.equal(b.get().instanceId, 'tui-b')
})

test('section 集合只有一个代码内注册表：新增区域只需局部修改（FR-12 反向 AC）', () => {
  const sections = [...defaultSections(), { name: 'extra', sourceRead: 'GET /api/ps (existing read)', drillShape: 'flat', rows: () => STUB.needs }]
  const s = createViewState({ instanceId: 't', sections })
  const r = s.dispatch({ type: 'jump', section: 'extra' })
  assert.equal(r.section, 'extra', '注册表数组新增的区域无需其他修改即可访问')
})

test('每个已注册视图都可通过命令访问（R1.2 的结构性可驱动性）', () => {
  const s = createViewState({ instanceId: 't' })
  for (const sec of s.get().sections) {
    s.dispatch({ type: 'jump', section: sec.name })
    assert.equal(s.get().section, sec.name)
  }
})

test('下钻到已知智能体会在拓扑中定位它；未知目标会在状态中形成具名错误', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'drill', resource: 'agent', name: 'dev50.driver' })
  assert.equal(s.get().section, 'topology')
  assert.deepEqual(s.get().drill.at(-1), { kind: 'agent', name: 'dev50.driver' })
  assert.equal(s.get().lastError, null)

  s.dispatch({ type: 'drill', resource: 'agent', name: 'nobody.here' })
  assert.match(s.get().lastError, /智能体不存在/)
  assert.match(s.get().lastError, /nobody\.here/)
})

test('跨视图导航 spec-of：运行中智能体 -> 其智能体 spec（Specs 区域）', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'cross', kind: 'spec-of', name: 'dev50.driver' })
  assert.equal(s.get().section, 'specs')
  assert.deepEqual(s.get().drill.at(-1), { kind: 'spec', name: 'driver-agent' })
})

test('跨视图导航 running：spec -> 筛选到运行该 spec 席位的拓扑', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'cross', kind: 'running', name: 'driver-agent' })
  assert.equal(s.get().section, 'topology')
  assert.ok(s.get().runningOf === 'driver-agent')
})

test('filter 只改变当前视图，空文本会清除过滤条件', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'filter', text: 'dev50' })
  assert.equal(s.get().filter, 'dev50')
  s.dispatch({ type: 'filter', text: '' })
  assert.equal(s.get().filter, '')
})
