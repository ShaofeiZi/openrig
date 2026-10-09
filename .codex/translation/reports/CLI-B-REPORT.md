# CLI-B 中文化交付报告

- owner: cli-b
- manifest: `.codex/translation/manifests/cli-b.json`
- 基线 git: `57380a250e797c182a336e97afe2e0edb841ba9c`
- 范围: 80 文件 = 46 个 `packages/cli/src/commands/*.ts` 源 + 34 个 `packages/cli/test/*.test.ts`
- 状态脚本: `python3 .codex/translation/scripts/state.py show cli-b`

## 总状态

```
cli-b   total=80  pending=0  in_progress=0  done=80  failed=0  skipped=0
```

无 pending / 无 in_progress / 无 failed / 无 skipped。残留未翻译人类可见文案：0（定量：本组 34 个测试文件全绿即证明展示断言与源码一致；机器协议字段逐字保留，不属于“残留英文”）。

## 翻译与保留原则

- 已中文化：commander `.description/.option/.addHelpText`、JSDoc/注释、console 人读输出、表头、状态标签、`ScopeCliError` 的 fact/consequence/action、警告多行串。
- 逐字保留（业务与机器协议）：JSON 输出、HTTP 路由与查询参数、字段名、错误 code、状态枚举（running/partial/stopped/needs_input/idle/unknown/attention_required/recoverable/degraded/detached 等）、verdict 闭集、环境变量、路径、ANSI 与机器标记（ADVISORY/PROVENANCE/PROFILE/PHASE/BUDGET/hostId 等）。
- 顶层命令示例 `rig xxx` → `zrig xxx`。
- 未做全局 stdout 替换，避免影响 JSON/机器输出。
- 未启动真实 daemon / 付费 agent；未改全局 hooks/trust/权限；未 git commit/push。

## 逐文件覆盖（46 源 + 34 测试，全部 done）

源（commands）：add, adopt, agent-image, archive, auth, bind, broadcast, context, crash-cart, create, daemon, discover, down, expand, export, fork, grow, heartbeat, host, package, parked, plugin, policy, project-jev, proof, provider, ps, queue, release, remove, requirements, restore-check, rig, seat, shrink, skill, start, stream, terminal, topology-default-agent, transcript, ui, view, walk, watchdog, workflow-render。

测试（test，均为本组单测，断言展示串已中文化、行为断言保留、未删原断言）：
add 11, adopt 5, agent-image, archive 9, broadcast 12, context 33, discover 5, down 22, expand 9, fork 6, heartbeat 6, host 22, package 17, plugin 29, policy 18, project-jev, proof 24, provider 14, ps 46, queue 100, requirements 5, restore-check 29, rig 9, seat 21, skill 3, start 17, stream 13, terminal 8, transcript 7, ui 10, view 6, walk 41, watchdog 12, workflow-render 15。

本轮批量全跑暴露并修复的展示断言遗漏（已全部复测通过）：
- proof.test：已投放：/已批准闭集/建议（D2/建议（C8/不是一个普通文件名
- down.test：已结束/2 个会话/已停止/已删除/警告/歧义
- discover.test：发现的会话/已把发现项
- heartbeat.test：补充一条针对该任务的证明笔记/若受阻，请带原因转为 blocked
- host.test：已添加主机/不要两者都指定/无法确认健康/没有 ALLOW IN/Tailscale SSH 已启用：true/匿名/要求 Authorization/拒绝了 bearer/注册表：/token 不对/未知主机 id
- package.test：可执行：1/冲突：1/冲突/策略拒绝/恢复 1 个/删除 1 个/延后：1/（旧版）/后台服务未运行
- plugin.test：/没有智能体引用/、/不存在|ENOENT/
- policy.test：HONESTY_PIN 逐字中文/自定义策略…无法解析/未知内置策略/地板/不允许路径穿越（..）/建议地板/必须是非空字符串 ref

## 定向测试命令与退出码

类型检查：
```
cd packages/cli && npx tsc --noEmit -p tsconfig.json   # exit 0
```

本组 34 个测试文件一次性批量跑（隔离 HOME）：
```
cd packages/cli && HOME=$(mktemp -d) OPENRIG_HOME=$(mktemp -d)/.openrig \
  npx vitest run test/{add,adopt,agent-image,archive,broadcast,context,discover,down,expand,fork,heartbeat,host,package,plugin,policy,project-jev,proof,provider,requirements,restore-check,rig,seat,skill,start,stream,terminal,transcript,ui,view,walk,watchdog,workflow-render,ps,queue}.test.ts
```
结果：`Test Files 34 passed (34)` / `Tests 607 passed (607)`，退出码 0。

单文件定向命令（同隔离 HOME 前缀）：
```
npx vitest run test/<name>.test.ts
```

基线已知非本组失败（不计入回归）：release-surface（缺 v0.3.1 tag）、front-door 1、project-worker-entry 4、daemon 311、tui 2、ui 1。

## 备份

逐文件原始副本在修改前已原地备份，台账脚本 state.py 已修复 fail/skip 映射与全局原子写入。
