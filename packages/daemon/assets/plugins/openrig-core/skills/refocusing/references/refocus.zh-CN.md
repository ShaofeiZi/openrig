# 重新聚焦

1. 对方真正希望得到的是什么？不要回答你当前的任务，而要说明最终结果。
2. 你**此刻**正在做的事情，是否在推动该结果？如果说不清用户最终会得到什么，就停下来如实说明。
3. 有哪些结论是你在没有打开文件、也没有实际运行目标的情况下作出的？

只要其中任何一点让你感到不踏实，就说明可能发生了偏移：偏移通常会伪装成工作。

`refocusing` skill 提供与事实源匹配、只包含路径的追踪方式。默认情况下，其 `scripts/trace-to-root.py` 会遍历当前的两棵树：先查看拓扑中的 `LEARNED.md`，再查看工作中的 `SPEC.md` 意图和 `NOTES.md`。使用 `OPENRIG_REFOCUS_TREES=topology|work|both` 调整遍历范围，使用 `OPENRIG_REFOCUS_DEPTH=light|full` 调整读取深度。

无需编辑 plugin 即可替换该默认内容。内容优先级从高到低如下：

1. `OPENRIG_REFOCUS_CONTENT_REF`，由 `zrig context get` 解析。
2. `OPENRIG_REFOCUS_CONTENT_FILE`，由操作方编写的文件。
3. `$OPENRIG_HOME/refocus/REFOCUS.md`，实例级内容。
4. 当前随附的默认内容。

新席位会单独收到入门资源 `openrig-onboarding-01.md` 和 `openrig-onboarding-02.md`。本文档只引用这些资源，不复制其中的整体环境安装说明。
