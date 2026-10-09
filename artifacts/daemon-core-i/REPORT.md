# daemon-core-i 中文化交付报告

- 执行模式：源码与测试两个互斥文件集并行；各文件内部串行处理。
- 备份：`.codex/translation/backup/daemon-core-i/original-backup.tar.gz` 已确认存在。
- 台账：97 个文件，96 done，1 skipped，0 pending，0 in_progress，0 failed。
- 本轮完成：80 个原 pending 文件，其中 31 个 `packages/daemon/src/**` 源码文件、49 个 `packages/daemon/test/**` 测试文件。
- 跳过：`packages/daemon/src/domain/package-repository.ts`；纯数据库存取与字段映射，无自然语言注释、日志或用户可见文案。

## 约束落实

- 已翻译自然语言注释、测试标题，以及明确由人或智能体阅读的展示文案。
- 保留 JSON key/value 协议、枚举、错误码、事件名、SQL、路径、命令参数、fixture 机器值与旧入口兼容语义。
- 用户命令示例在允许的展示层改用 `zrig`；作为既有协议 payload 的命令字符串保持原样。
- 未删除测试、未弱化行为断言、未修改原始 Markdown。
- 未运行测试、build 或 typecheck；未启动后台服务或真实席位；未提交或推送。

## 静态验证

- owner 范围 `git diff --check`：通过。
- verifier `rubric check-file-format`：97/97 通过。
- 占位符残留检查（临时替换标记）：0。
- 测试文件独立检查：49/49 格式与可读性通过，49/49 CJK 检查通过。

## 建议统一验证

优先：`restore-check-service.test.ts`、`send-prompt-guard.test.ts`、
`sessions-routes.test.ts`、`startup-proof.test.ts`、
`scenario-real-deps.test.ts`。

其次：`workflow-routes.test.ts`、`transcript-store.test.ts`、
`watchdog-policy-engine.test.ts`、`hosts-add-pair-routes.test.ts`、
`s02-p1-classification-persistence.test.ts`、`seat-lifecycle-service.test.ts`。

`review/compose.ts` 的展示文案还会影响其他 owner 的 review/UI/TUI 断言，已将具体同步清单报告给协调者。
