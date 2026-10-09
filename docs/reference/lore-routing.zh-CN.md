# Lore 路由 —— 按地址安放知识

Lore 是一个持久位置在做其工作时挣得的知识。它住在该位置的席位树下，当另一个产物需要它时按地址组合进来。它的价值是内容**与在哪儿学到**的组合；把字节拷进一个共享库就毁掉了这个区分。

本约定定义条目形状、稳定地址、组合授权，以及 lore 派生内容离开位置边界的唯一路径。它不新增解析器、源种类、策展角色或转录挖掘流程。

## 住所、归属与稳定地址

每个条目是所属席位 `lore/` 目录下的一个 Markdown 文件：

```text
<topology-root>/rigs/<rig>/seats/<seat>/lore/<stable-slug>.md
```

从配置解析 `topology.root`；绝不硬编码根。所属席位是唯一直接作者。它以持久位置的身份写作，而不是某个具体占用者或前任。

文件名描述情境或触发，绝不含 stage、日期、占用者代际或版本。因此它的地址稳定：

```text
seat:lore/<stable-slug>.md
seat:lore/<stable-slug>.md#situation
```

stage 变更只编辑 frontmatter 和 `date`；绝不重命名文件。变更后既有引用必须继续解析。

## 必填元数据

每个 lore 条目从诞生起就带这些字段：

| 字段 | 含义 |
|---|---|
| `taxonomy` | 恰为 `lore`。这是机器可读的隐私类。 |
| `stage` | 当前认知成熟度。合法取值只来自 [`knowledge-maturity.md` 的"两种编码，一架梯子"](knowledge-maturity.md#two-encodings-one-ladder)；不要在这里复制或扩展那个词汇。 |
| `method` | 所属位置如何可能知道这条主张：观察、对比、事件或来源方法。 |
| `date` | 当前 stage 决定或实质修订的 UTC 日期时间。`stage` 变更时更新它。 |
| `position` | 规范所属席位地址，`<seat>@<rig>`。它命名位置，绝不命名占用者。 |

`taxonomy: lore` 在每个条目的 frontmatter 和任何服务它的带 manifest 的 lore pack 上都必须有。拼写错误不等价，必须让任何提取该类的机器 pin 失败。

## 条目模板

从这个模板开始一个情境形状的条目。替换每个占位符；`wip` 是起始标签，权威词汇仍是上面引用的那个。

```markdown
---
taxonomy: lore
stage: wip
method: "<这个位置如何可能知道>"
date: "YYYY-MM-DDTHH:MM:SSZ"
position: "<seat>@<rig>"
---

# <简短的情境或触发>

## Situation

**Position:** `<seat>@<rig>`

**Moment.** <这条知识在什么时候变得有用？>

**Reflex.** <哪个诱人的反应很可能是错的？>

**Instead.** <读者该怎么做？>

**Because.** <是什么证据或失败造成了区别？>
```

当一条事实确实是可迁移单元时，可以用 `## Fact`。任何想作为节级附件的 H2 都重复规范的 `Position:` 行，好让解析器只返回那一节时归属仍可见。

## 寻址与组合

Lore 用既有的 `seat:` 语法和一个显式的 rig-and-seat 读取授权。地址说读哪个文件或节；授权说该地址相对于谁的席位树。没有授权就是不能读。

安装时组合整个条目地址（`seat:lore/<slug>.md`），好让它的 frontmatter、taxonomy、stage、method、date 和 position 随内容一起走。被组合的一块必须可见地保留：

- 解析器给的 `seat` 来源标签；
- 条目字节里的所属 `position`；以及
- 同时来自条目和 lore-pack 元数据的 `taxonomy: lore` 类。

把一个席位的 lore 服务进另一个席位的安装，只允许在调用方显式授予所属席位树时进行。产出的那块仍归属原作者；接收席位不继承它的身份。

一个附着点只是一个指针配对所属位置：

```yaml
lore:
  address: "seat:lore/<stable-slug>.md#situation"
  position: "<seat>@<rig>"
```

附着从不嵌入或拷贝 lore 字节。读者在更深上下文相关时，用具名位置的显式授权去解析它。

## Stage 变更

要改变成熟度：

1. 只编辑 `stage` 和 `date`，除非主张本身也变了。
2. 重新解析同一个 `seat:lore/<stable-slug>.md` 地址。
3. 确认地址未变，新 stage 和 date 可见。

如果一次 stage 变更是破坏地址的，停下：那种存储形状违反本约定。`superseded` 和 `retired` 遵循所引成熟度住所的语义；这里不发明 lore 专属替代。

## 对外门禁

一个 lore 产物绝不通过拷贝、导出、服务或打包，从工作组本地位置知识进入共享或可发布受众。工作组内部的、授权门控的读侧组合不是毕业，它保留来源地址和位置。它的内容只能通过**撰写式重新落户**进入一个新的对外产物：

1. 所属席位撰写目标产物，或记录一条指向其作者的显式委托。
2. 目标产物用自己的话为新受众写；lore 文件本身字节不变。
3. 目标产物记录毕业事件：

```yaml
graduation:
  source_address: "seat:lore/<stable-slug>.md"
  source_stage: "<毕业时的 stage>"
  date: "YYYY-MM-DDTHH:MM:SSZ"
  owner: "<seat>@<rig>"
  delegation: "none | <谁委托给谁>"
  warrant: "<为什么这内容配得上新受众>"
```

4. 如果目标可发布，它必须通过公开物质准入门。把拷贝的 lore 改名、重新打包、或宣称是另一个 pack 类，是洗白，不是毕业。

来源地址、来源 stage、owner/委托、日期和 warrant 让这次迁移从目标端可审计。源 lore 条目绝不只因要宣布"另一个产物从它毕业"而被编辑。

## 隐私边界

Lore 是工作组本地位置知识。可发布投影和 bundle 路径必须在结构上拒绝 `taxonomy: lore`，独立于 token 拒绝清单或内容扫描器。既有针对席位文件的包含保护继续有效。

本约定刻意不创建：

- 自动的转录或记忆挖掘；
- 一个 lore 管理员、中央策展队列或评审仪式；
- 跨工作组 lore 共享；
- 新的地址语法、解析器种类或公开导出形式。

增长由 owner 撰写、自然发生。一个席位在活过的工作让某个情境值得保留时写一条；消费方在自己的情境召唤时按地址附着或组合它。
