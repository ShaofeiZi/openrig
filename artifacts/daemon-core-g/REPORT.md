# daemon-core-g 中文化报告

- Owner：`daemon-core-g`
- 执行方式：串行；逐文件通过 `state.py claim` 与 `state.py done/skip` 更新台账
- 总文件数：98
- 完成：97
- 跳过：1
- 失败：0
- 未处理：0

## 跳过项

- `packages/daemon/src/domain/telemetry-state-paths.ts`：只有路径、环境变量、文件名和机器常量，不含自然语言注释、日志或用户可见文案。

## 关键完成项

- `packages/daemon/src/domain/restore-check-service.ts`：完整中文化人类可读 `evidence`、`remediation`、`summary` 与用户命令；保留 `check`、`status`、`code`、JSON key、枚举与路径。
- `packages/daemon/test/rig-agents-compose.test.ts`：对照最新 `review/compose.ts` 同步“没有正在或近期持有工作的智能体”“今日 N 次交接”“根据队列转换计算”等中文展示断言。
- 其余 owner 文件：翻译注释、测试标题、用户/智能体可读日志和错误；保留机器协议、key、enum、error code、事件名、SQL、路径、命令参数及 fixture 机器值。

## 验证

- `git diff --check -- <daemon-core-g 全部 owner 文件>`：退出码 0。
- TypeScript parser：96 个 done 文件，语法诊断 0。
- verifier-hub `file validate --expected-ext .ts`：97/97 通过。
- verifier-hub `text must-contain`：`restore-check-service.ts` 中 `zrig daemon start`、`zrig restore-check`、`zrig up --existing` 全部存在。
- verifier-hub `text must-contain`：`rig-agents-compose.test.ts` 中关键中文展示断言全部存在。
- 按任务要求未运行测试、build 或 typecheck，未启动后台服务或真实席位。

## 建议统一验证的测试

- `packages/daemon/test/restore-check-service.test.ts`
- `packages/daemon/test/restore-check-routes.test.ts`
- `packages/daemon/test/rig-agents-compose.test.ts`
- `packages/daemon/test/seat-lifecycle-service.test.ts`
- `packages/daemon/test/seat-attention-reconciler.test.ts`
- `packages/daemon/test/plugin-discovery-service.test.ts`
- `packages/daemon/test/slice-indexer.test.ts`
- `packages/daemon/test/workflow-deadline.test.ts`

