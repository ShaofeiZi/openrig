# 迁移一个早于约定的工作组的拓扑上下文

适用于那些手工撰写的上下文早于 chain-file 约定、且仍在旧位置（`~/.openrig/shared-docs/rigs/<rig>/`，或 `$OPENRIG_SHARED_DOCS_ROOT/rigs/<rig>/`）的工作组。这里没有任何破坏性操作：旧树原样保留，全程读取都正常（walker 会在回退时发 advisory），每次拷贝都是 no-clobber（不覆盖已有）。

## 路径与确切命令

```bash
# 0. 搞清两个根 —— 绝不要硬编码任何一个。
DEST="$(zrig config get topology.root)"
SRC="${OPENRIG_SHARED_DOCS_ROOT:-$HOME/.openrig/shared-docs}/rigs"

# 1. 迁移前：证明回退机制确实在承载这个工作组（每一层解析到旧位置时，
#    都应在 stderr 看到 ADVISORY 行）。
zrig context trace --rig <rig> --seat <seat> --name LEARNED.md

# 2. 预览迁移（dry run —— 什么都不动）。
rsync -av --ignore-existing --exclude 'state/' --dry-run "$SRC/<rig>/" "$DEST/rigs/<rig>/"

# 3. 迁移。--ignore-existing 镜像安装器的"不存在才拷贝"法则：
#    已经在 topology.root 下挣得的内容绝不被覆盖。
mkdir -p "$DEST/rigs/<rig>"
rsync -av --ignore-existing --exclude 'state/' "$SRC/<rig>/" "$DEST/rigs/<rig>/"

# 4. 迁移后：同一个 trace 现在按规范路径解析 —— advisory 消失了。
zrig context trace --rig <rig> --seat <seat> --name LEARNED.md

# 5. 不要在同一个会话里删除旧树。等每个消费方（队列状态 add-dir、
#    评审产物、脚本）都确认切走之后，再另找时间归档它——在此期间，
#    经过回退的读取仍然正确，这正是 fail-open 的意义。
```

## 什么迁移、什么不迁移

- **迁移：** 工作组的 chain 文件和席位目录 —— `LEARNED.md`、`CULTURE.md`、工艺文件、`seats/<seat>/…`。
- **暂留：** `state/`（队列状态 add-dir 和活产物正被运行中的席位持续写入；把它们挪到活工作组之下会把写入者 stranded——那次切换是一次独立的、有自己收据的变更）。
- **绝不：** 写进任何正在运行的席位的上下文。迁移只是挪文件；把内容投递给运行中的席位要走 refocus 通道（`docs/reference/refocus-channel.md`）——编辑文件不等于投递。

## 迁移之后

下次对一个自带拓扑默认值的 spec 跑 `zrig up` 时，会按"不存在才拷贝"把默认值装在迁移过来的内容旁边——挣来的上下文永远胜过自带默认。有疑问就用 trace 验证，不要靠记忆。
