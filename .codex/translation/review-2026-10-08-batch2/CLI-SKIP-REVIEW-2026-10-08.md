
## 纠错审计（2026-10-09）
- 误把 cli/test/openrig-compat.test.ts 按"openrig"前缀猜为通过对象，升为 passed。
- 实际通过的是 daemon/test/openrig-core-plugin.test.ts（b2-139 46过）。
- 已恢复 openrig-compat 至 self_reported 原状态，openrig-core-plugin 锁 passed。
- 教训：禁止按 openrig 前缀近似匹配，必须精确 source_path。

## 纠错审计2（2026-10-09）
- 误把 new-batch2（preflight/proof/ps-current-rig/queue-cross-host-cli/scope-convention-scaffold）在测试未跑完时锁 passed。
- 实际应锁的是 new-batch1（config/cross-host-executor/cross-host-target/front-door/plugin）b2-141 122过。
- 已恢复 new-batch2 五文件原 validation/notes，new-batch1 五文件锁 passed。
- 教训：读错 batch 编号；以后仅验证者明确回结果才 pass。
