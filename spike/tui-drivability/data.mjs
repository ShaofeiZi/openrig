// Stub 数据代替 §4.A 的后台服务读取。数据结构与真实端点足够接近，可用于验证导航；
// 此 spike 不会调用后台服务。
export const STUB = {
  hosts: [
    {
      name: 'vm-host',
      reachable: true,
      rigs: [
        {
          name: 'openrig-build',
          pods: [
            {
              name: 'dev50',
              agents: [
                { name: 'dev50.driver', runtime: 'claude-code', spec: 'driver-agent', context: 62, tokens: '118k', status: 'running' },
                { name: 'dev50.guard', runtime: 'codex', spec: 'guard-agent', context: 31, tokens: '54k', status: 'idle' },
                { name: 'dev50.qa', runtime: 'codex', spec: 'qa-agent', context: null, tokens: null, status: 'unknown' },
              ],
            },
            {
              name: 'orch',
              agents: [
                { name: 'orch.lead', runtime: 'codex', spec: 'lead-agent', context: 88, tokens: '203k', status: 'needs-attention' },
              ],
            },
          ],
        },
      ],
    },
    { name: 'mm2-host', reachable: false, rigs: [] },
  ],
  specs: {
    rig: [{ name: 'openrig-build-rig', agentRefs: ['driver-agent', 'guard-agent', 'qa-agent', 'lead-agent'] }],
    agent: [
      { name: 'driver-agent', runtime: 'claude-code', usedByRigs: ['openrig-build-rig'] },
      { name: 'guard-agent', runtime: 'codex', usedByRigs: ['openrig-build-rig'] },
      { name: 'qa-agent', runtime: 'codex', usedByRigs: ['openrig-build-rig'] },
      { name: 'lead-agent', runtime: 'codex', usedByRigs: ['openrig-build-rig'] },
    ],
  },
  needs: [
    { kind: 'idle-with-work', target: 'dev50.guard', detail: '已分配工作，空闲 42 分钟' },
    { kind: 'host-down', target: 'mm2-host', detail: '不可达 12 分钟' },
  ],
}

export function findAgent(name) {
  for (const host of STUB.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.name === name) return { host, rig, pod, agent }
  return null
}

export function findSpec(name) {
  return STUB.specs.agent.find((s) => s.name === name) ?? STUB.specs.rig.find((s) => s.name === name) ?? null
}

export function findRig(name) {
  for (const host of STUB.hosts) for (const rig of host.rigs) if (rig.name === name) return { host, rig }
  return null
}

export function findHost(name) {
  return STUB.hosts.find((h) => h.name === name) ?? null
}

export function agentsRunningSpec(specName) {
  const out = []
  for (const host of STUB.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.spec === specName) out.push(agent.name)
  return out
}
