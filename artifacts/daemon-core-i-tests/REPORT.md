# daemon-core-i 测试中文化报告

- 范围：`daemon-core-i` manifest 中本轮开始时为 `pending` 的全部 `packages/daemon/test/**` 文件
- 执行方式：串行逐文件 `claim`、翻译、残留与 diff 审查、`done`
- 本轮文件：49
- 完成：49
- 跳过：0
- 失败：0
- 未处理：0
- owner 测试范围最终状态：61 done，0 pending，0 in_progress，0 failed，0 skipped

## 变更边界

- 仅修改测试标题、自然语言注释，以及已由生产层中文化的人类展示文案断言。
- 保持 API/JSON 字段、枚举、错误码、事件名、SQL、路径、命令参数、fixture 机器值和行为断言不变。
- 用户命令示例使用 `zrig`；旧入口兼容与实际 argv 协议保持不变。
- 未修改任何 `packages/daemon/src/**` 文件。

## 静态验证

- `git diff --check -- <49 files>`：退出码 0。
- verifier `rubric check-file-format <file> --expected-ext .ts`：49/49 通过；此 verifier 对 TypeScript 仅确认文件存在且可读。
- verifier `text must-contain --regex '[一-龥]'`：49/49 通过。
- verifier 针对关键展示同步检查：
  - `restore-check-service.test.ts` 包含 `zrig daemon start`、`zrig up --existing test-rig`、`缺少工作组根目录`：3/3。
  - `sessions-routes.test.ts` 包含三条 `zrig` 辅助命令和中文未找到文案：3/3。
  - `startup-proof.test.ts` 包含 `zrig startup-proof submit` 与 `启动证明`：2/2。

未运行测试、构建或类型检查；这是任务的明确约束。未启动后台服务，未提交或推送。

## 建议定向测试文件

优先验证展示断言与命令品牌同步：

- `packages/daemon/test/restore-check-service.test.ts`
- `packages/daemon/test/send-prompt-guard.test.ts`
- `packages/daemon/test/sessions-routes.test.ts`
- `packages/daemon/test/startup-proof.test.ts`
- `packages/daemon/test/scenario-real-deps.test.ts`

其次验证大范围标题/注释编辑未引入语法问题：

- `packages/daemon/test/workflow-routes.test.ts`
- `packages/daemon/test/transcript-store.test.ts`
- `packages/daemon/test/watchdog-policy-engine.test.ts`
- `packages/daemon/test/hosts-add-pair-routes.test.ts`
- `packages/daemon/test/s02-p1-classification-persistence.test.ts`
- `packages/daemon/test/seat-lifecycle-service.test.ts`

完整 49 文件清单以 `.codex/translation/manifests/daemon-core-i.json` 中本轮新增的 `done` 记录为准。
