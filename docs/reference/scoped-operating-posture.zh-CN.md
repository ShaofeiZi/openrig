# 范围化工作姿态

人主导的工作，默认对纯流程类诊断保持安静。委派出去的工作，在规划和实现期间都可以接受监督。这个偏好不授予执行权限，也不改变权限、工作阶段、工作流提醒、上下文/连续性健康或健康策略。

## 查看与选择

用既有的 `rig mode` 界面。给一个确切的工作组或撰写好的工作范围：

```sh
zrig mode effective --rig my-rig --json
zrig mode effective --project my-project --mission release-1 --json
zrig mode effective --qitem my-packet --json
zrig mode set delegated --scope mission --qualifier my-project/release-1 --evidence "Operator delegated this outcome"
# 上面的提议不带 --confirm 时以退出码 2 拒绝写入。应用这个刻意选择：
zrig mode set delegated --scope mission --qualifier my-project/release-1 --evidence "Operator delegated this outcome" --confirm
zrig mode set human-led --scope mission --qualifier my-project/release-1 --evidence "Return to interactive planning" --confirm
zrig mode unset mission my-project/release-1
```

取消设置会暴露出下一个适用的显式选择，或可见的人主导产品默认。一个新的、已解析的、无绑定的工作组会报告 `human-led`、`source: product-default`、`binding: null`。缺失范围身份、链接冲突、存储不可用或撰写上下文畸形，会带原因报告 `unknown`。不带范围调用 `effective` 不会隐式选一个工作组。既有的操作员 bearer 要求仍然适用。`set` 需要 `--confirm`；`unset` 是显式删除命令，立即生效。

## 一个范围与阶段契约

`GET /api/rig-mode/effective` 接受 `rig`、`project`、`mission`、`workstream` 和 `qitem`。它增量返回的 `operatingPosture` 对象也挂在健康记录和诊断发现上。CLI 解释和 TUI 健康详情展示同一份数据。姿态、阶段和健康的消费方应当用这个对象，而不是另造偏好存储，或从工作流存在与否或活动推断委派。

| 字段 | 含义 |
| --- | --- |
| `posture` | `human-led`、`delegated` 或 `unknown` |
| `source` | `product-default`、`binding` 或 `unknown` |
| `context` | 解析出的 rig/project/mission/workstream/qitem ID、来源地址、规范撰写路径和阶段；范围解析失败时为 null |
| `context.phase` | 来自显式工作流包步骤的 `{value, source}`，否则 slice 阶段/状态，否则任务目标发布阶段/状态；不可用时字段为 null |
| `binding` | 胜出的绑定 ID、范围、时间戳和证据引用；默认/unknown 时为 null |
| `reason` | 对结果或缺失/冲突事实的解释 |
| `grantsAuthority` | 永远 `false` |
| `members` | 对队列支撑的发现，逐个成员的 qitem、posture、source 和绑定 ID；成员姿态不一致或未知时，聚合姿态为 unknown |

既有的 SQLite mode-binding 表仍然是唯一的偏好存储。匹配姿态绑定按此顺序解析：qitem、workstream、mission、project、rig、全局主机。限定符分别是 qitem ID、`project/mission/slice-id`、`project/mission`、project ID、规范 rig ID 和 null。rig 名解析为 ID。workstream 是一个既有撰写 slice，按其目录或 SPEC ID 找；返回身份用它的 SPEC ID 和 project/mission 限定。

项目选择读 `workspace.yaml` 声明的 `projects: [{id, root}]` 目录；没有目录时读工作区自己的 `project.yaml`。多个项目需要显式选一个。单一项目可派生。项目 manifest 校验身份并提供 `missions.root`（默认 `missions`）。mission 和 slice 身份来自那些撰写的工作节点；缺失、重复或冲突身份保持 unknown。选中的工作必须待在它的规范项目根内。

qitem 读取 join 显式的 `project:`、`mission:`、`slice:`/`workstream:` 标签、目的地工作组和既有工作流包绑定。工作流生命周期的 project/mission 身份必须与标签和请求范围一致。绑定包的确切步骤是阶段来源；阶段名不靠猜分类。一个未链接的 qitem 不静默继承默认。范围读取是观察性的。

旧的人体工学模式（`sleep`、`desk`、`mobile`、`away`、`focus`、`debug`）保留它们的绑定和十字段记录。它们不暗示任何一种工作姿态。只有 human-led/delegated 绑定参与姿态优先级。旧的 `effective` 和 `posture: known|unknown_posture` 字段为兼容保留；那里的 `unknown_posture` 表示没有旧模式绑定，不覆盖新的 `operatingPosture.source: product-default` 结果。在同一范围设置另一个模式会替换那一行；任何模式变更后都要查看 effective 姿态。

## 诊断效果

流程类发现无论 human-led 还是 unknown 姿态都保持可见，但新的诊断呈现、再呈现和人类通知需要显式 delegated 姿态。已保留的出现记录不随姿态变更被取消或重写。它们的当前发现会刷新以供查看和通知；不可用的当前发现不能复用旧的 delegated 姿态。通知准入在就绪 I/O 后重新检查。

委派对流程中断是必要的，但本身不充分：启用的诊断策略、检测器选择、来源新鲜度、保管、冷却、复发上限和人类投递就绪仍然适用。其他健康类别和普通队列/工作流提醒保持既有行为。自动仪式来源通过同一解析器读声明的目录项目；未解析的谱系保持以 unknown 范围可见，而不是获得虚构的权威。

策略、证据和处置见[健康诊断](health-diagnosis.md)。
