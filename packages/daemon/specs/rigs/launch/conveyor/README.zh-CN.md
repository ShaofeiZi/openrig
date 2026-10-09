# Conveyor 起始模板

Conveyor 是 zrig 0.3.0 的起始工作组，用于学习队列交接和工作流实例。

## 运行

```bash
zrig up conveyor
```

## 工作流

- `conveyor`：站点流水线。可以同时有多个活动工作包。
- `basic-loop`：单工作项演练，用于观察一个工作包如何在同一组席位之间流转。

## 示例目标

可将下列内容作为第一个工作包：

```text
为命令行工具起草一份简短的发布就绪检查清单。清单保持五项，并包含一条验证命令。
```

预期流转过程：

1. `intake-lead@conveyor` 澄清工作包并将其交给规划环节。
2. `plan-planner@conveyor` 将其转化为一份小型计划。
3. `build-builder@conveyor` 起草检查清单。
4. `review-reviewer@conveyor` 检查结果。
5. `intake-lead@conveyor` 使用证据关闭工作包。
