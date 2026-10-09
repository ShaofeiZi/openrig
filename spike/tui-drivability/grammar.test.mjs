import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from './grammar.mjs'

test(':section 跳转可解析三个启动区域', () => {
  assert.deepEqual(parseCommand(':topology'), { type: 'jump', section: 'topology' })
  assert.deepEqual(parseCommand(':specs'), { type: 'jump', section: 'specs' })
  assert.deepEqual(parseCommand(':needs'), { type: 'jump', section: 'needs' })
})

test('未知 :section 会返回具名错误，绝不会静默成为 no-op', () => {
  const r = parseCommand(':bogus')
  assert.equal(r.type, 'error')
  assert.match(r.message, /未知区域/)
  assert.match(r.message, /bogus/)
})

test('/text 过滤当前视图；单独的 / 会清除过滤条件', () => {
  assert.deepEqual(parseCommand('/driver'), { type: 'filter', text: 'driver' })
  assert.deepEqual(parseCommand('/'), { type: 'filter', text: '' })
})

test('<resource> <name> 下钻可解析已知资源类型', () => {
  assert.deepEqual(parseCommand('rig openrig-build'), { type: 'drill', resource: 'rig', name: 'openrig-build' })
  assert.deepEqual(parseCommand('agent dev50.driver'), { type: 'drill', resource: 'agent', name: 'dev50.driver' })
  assert.deepEqual(parseCommand('host vm-host'), { type: 'drill', resource: 'host', name: 'vm-host' })
  assert.deepEqual(parseCommand('spec driver-agent'), { type: 'drill', resource: 'spec', name: 'driver-agent' })
})

test('可解析跨视图导航动词', () => {
  assert.deepEqual(parseCommand('spec-of dev50.driver'), { type: 'cross', kind: 'spec-of', name: 'dev50.driver' })
  assert.deepEqual(parseCommand('running driver-agent'), { type: 'cross', kind: 'running', name: 'driver-agent' })
})

test('未知命令返回包含错误 token 的具名错误', () => {
  const r = parseCommand('frobnicate xyz')
  assert.equal(r.type, 'error')
  assert.match(r.message, /未知命令/)
  assert.match(r.message, /frobnicate/)
})

test('缺少名称的下钻返回具名错误', () => {
  const r = parseCommand('agent')
  assert.equal(r.type, 'error')
  assert.match(r.message, /agent/)
})

test('空输入是显式带类型的 no-op 操作，而不是静默忽略', () => {
  assert.deepEqual(parseCommand(''), { type: 'noop' })
  assert.deepEqual(parseCommand('   '), { type: 'noop' })
})
