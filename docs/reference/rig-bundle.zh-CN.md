# RigBundle 参考

版本：2（pod 感知）
最近一次对照代码校验：2026-04-11
真源：`packages/daemon/src/domain/bundle-types.ts`、`packages/daemon/src/domain/bundle-archive.ts`、`packages/daemon/src/domain/pod-bundle-assembler.ts`

一个 `.rigbundle` 是一个自包含的可分发归档，把一个工作组 spec、所有引用的智能体 spec、它们的资源（skills、指引、启动文件）、文化文件、文档和一个完整性清单打进单个文件。接收方不需要原始源码树就能安装并启动该工作组。

---

## 归档格式

一个 `.rigbundle` 文件是一个 gzip 压缩的 tar 归档（`.tar.gz`），结构固定。

### 文件扩展名

归档**必须**用 `.rigbundle` 扩展名。打包器拒绝不以 `.rigbundle` 结尾的输出路径。

### 兄弟摘要文件

每个 `.rigbundle` 有一个兄弟 `.rigbundle.sha256` 文件，含归档的 SHA-256 十六进制摘要。这检测传输中的损坏。解包器在解压前校验这个摘要。

示例：
```
my-rig.rigbundle          —— 归档
my-rig.rigbundle.sha256   —— "a1b2c3d4..."（64 字符十六进制 SHA-256）
```

### 确定性

打包器产出确定性输出：
- 文件按字母序排序
- 用固定 mtime（`2026-01-01T00:00:00Z`）
- 可移植模式规范化 uid/gid/mode
- 最大 gzip 压缩（level 9）

这意味着相同输入永远产出相同归档哈希。

---

## 归档布局

```
bundle.yaml                    —— manifest（必需）
rig.yaml                       —— RigSpec（必需，可能被重写）
CULTURE.md                     —— 文化文件（若 rig spec 声明）
SETUP.md                       —— 文档（若 rig spec docs 字段声明）
agents/
  agent-name/
    agent.yaml                 —— AgentSpec
    guidance/
      role.md                  —— 指引文件
    skills/
      skill-name/
        SKILL.md               —— skill 文件
    startup/
      context.md               —— 启动文件
```

### 关键规则

- `bundle.yaml` 是 manifest —— 永远在场，永远在根
- `rig.yaml` 是工作组 spec —— 组装时随 vendor 的 `agent_ref` 路径一起重写
- 智能体目录是原智能体 spec 连同其全部资源的 vendor 拷贝
- import 引用从原始 `local:` 或 `path:` 路径重写为 bundle 相对的 `local:` 路径
- 归档内所有文件路径都是安全相对路径（无 `..`、无绝对、无符号链接）

---

## Manifest（`bundle.yaml`）

manifest 是归档根下一个 YAML 文件，描述 bundle 内容。

### Schema 版本 2（pod 感知，当前）

```yaml
schema_version: 2
name: my-bundle
version: "0.1.0"
created_at: "2026-04-11T22:32:48.570Z"
rig_spec: rig.yaml
agents:
  - name: pm-lead
    version: "1.0"
    path: agents/pm-lead
    original_ref: "local:agents/pm-lead"
    hash: "ed4cff20..."
    import_entries: []
  - name: researcher
    version: "1.0"
    path: agents/researcher
    original_ref: "local:agents/researcher"
    hash: "11f8a077..."
    import_entries:
      - name: shared
        version: "1.0"
        path: agents/shared
        original_ref: "local:../../shared"
        hash: "abc123..."
culture_file: CULTURE.md
integrity:
  algorithm: sha256
  files:
    rig.yaml: "b80c0674..."
    CULTURE.md: "9354361b..."
    agents/pm-lead/agent.yaml: "ed4cff20..."
    # ... 归档里每个文件
```

### Manifest 字段

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `schema_version` | number | 是 | pod 感知 bundle 必须为 `2`。 |
| `name` | string | 是 | Bundle 名。 |
| `version` | string | 是 | Bundle 版本。 |
| `created_at` | string | 是 | 创建的 ISO-8601 时间戳。 |
| `rig_spec` | string | 是 | 归档内工作组 spec 的相对路径。安全相对路径。 |
| `agents` | AgentEntry[] | 是 | vendor 的智能体条目数组。 |
| `culture_file` | string | 否 | 文化文件相对路径（若在场）。 |
| `integrity` | Integrity | 否 | 逐文件 SHA-256 校验和，用于内容校验。 |

### 智能体条目字段

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | 智能体名（来自 agent.yaml）。 |
| `version` | string | 否 | 智能体版本。 |
| `path` | string | 是 | vendor 智能体目录的相对路径。安全相对路径。 |
| `original_ref` | string | 是 | 重写前的原始 `agent_ref`。 |
| `hash` | string | 是 | agent.yaml 内容的 SHA-256 哈希。 |
| `import_entries` | ImportEntry[] | 是 | 本智能体的 vendor import（可为空）。 |

### Import 条目字段

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `name` | string | 是 | 被 import 的智能体名。 |
| `version` | string | 是 | 被 import 的智能体版本。 |
| `path` | string | 是 | 归档内 vendor import 的相对路径。 |
| `original_ref` | string | 是 | 重写前的原始 import 引用。 |
| `hash` | string | 是 | 被 import 的 agent.yaml 的 SHA-256 哈希。 |

### Integrity 段

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `algorithm` | string | 是 | 必须为 `sha256`。 |
| `files` | map<string, string> | 是 | 归档相对文件路径 → SHA-256 十六进制哈希的映射。归档里每个文件（`bundle.yaml` 自身除外）都应列出。 |

---

## 安全模型

Bundle 完整性提供**自洽校验，不是真实性**。

- 兄弟 `.sha256` 文件检测传输中损坏
- 逐文件完整性哈希检测归档内单个文件被篡改
- 两个机制都不认证 bundle 作者

一个能重写整个 bundle + 摘要的攻击者可以绕过校验。用户必须信任获得 bundle 的来源。这和未签名 npm 包、Docker 镜像的信任模型相同。

未来增强：加密签名（Ed25519）做作者认证。

---

## 安全保证

解包器在解压前强制这些安全规则：

1. **无符号链接或硬链接** —— 拒绝 `SymbolicLink` 和 `Link` 条目
2. **无绝对路径** —— 拒绝以 `/` 开头的条目
3. **无路径穿越** —— 拒绝含 `..` 段的条目
4. **摘要校验** —— 归档 SHA-256 必须匹配兄弟 `.sha256` 文件
5. **内容完整性** —— 解压后，逐文件哈希对照 manifest 校验

任一检查失败，解压中止并抛错。

---

## CLI 界面

### 创建 bundle

```bash
zrig bundle create <spec-path> -o <output.rigbundle> [--rig-root <dir>] [--name <name>] [--bundle-version <ver>]
```

| 标志 | 必需 | 默认 | 描述 |
|------|----------|---------|-------------|
| `<spec-path>` | 是 | —— | 工作组 spec YAML 文件路径。 |
| `-o, --output` | 是 | —— | 输出路径。必须以 `.rigbundle` 结尾。 |
| `--rig-root` | 否 | spec 目录 | 解析 `agent_ref` 和其他相对路径的根目录。 |
| `--name` | 否 | `my-bundle` | manifest 里的 bundle 名。 |
| `--bundle-version` | 否 | `0.1.0` | manifest 里的 bundle 版本。 |

create 命令：
1. 校验工作组 spec
2. 解析所有 `agent_ref` 路径及其 import
3. 把所有智能体 spec、资源和启动文件 vendor 到暂存目录
4. 把 `agent_ref` 路径重写为 bundle 相对的 `local:` 引用
5. 收集文化文件、文档文件和工作组级启动文件
6. 计算逐文件完整性哈希
7. 写 manifest（`bundle.yaml`）
8. 打包成确定性 `.tar.gz`
9. 写兄弟 `.sha256` 摘要

### 检视 bundle

```bash
zrig bundle inspect <bundle-path> [--json]
```

显示 manifest、摘要有效性和完整性校验结果。inspect 把归档解压到临时目录做安全校验，然后清理该目录。它不安装 bundle。

### 安装 bundle

```bash
zrig bundle install <bundle-path> [--plan] [--yes] [--target <root>] [--json]
```

| 标志 | 必需 | 默认 | 描述 |
|------|----------|---------|-------------|
| `<bundle-path>` | 是 | —— | `.rigbundle` 文件路径。 |
| `--plan` | 否 | `false` | 预览 bootstrap 计划，不安装或启动。 |
| `--yes` | 否 | `false` | apply 模式下自动批准受信任动作。 |
| `--target <root>` | apply 模式必需 | —— | 包安装的目标根目录。除非用 `--plan`，否则必需。 |
| `--json` | 否 | `false` | 发机器可读 JSON。 |

解压 bundle、校验完整性、bootstrap 该工作组。在 apply 模式下，daemon 需要 `targetRoot`，所以 `zrig bundle install` 必须给 `--target <root>`，除非你在用 `--plan`。

### 直接启动

```bash
zrig up <bundle-path> [--target <root>] [--cwd <dir>]
```

`zrig up` 自动识别 `.rigbundle` 文件，把它们路由到 bundle bootstrap 路径。

- `--target <root>` 控制打包文件装到哪
- 对一个 `.rigbundle` 省略 `--target` 时，CLI 默认安装目标为当前工作目录
- `--cwd <dir>` **不**改安装目标；它只覆盖那次运行里启动成员的工作目录

---

## 组装过程

当 `zrig bundle create` 跑时，`PodBundleAssembler` 执行这些步：

1. **解析并校验**工作组 spec
2. **收集工作组级文件：**
   - 文化文件（若设了 `culture_file`）
   - 文档文件（若设了 `docs` 数组）—— **必需：缺文档组装失败**
   - 工作组级启动文件
   - pod 级和成员级启动文件
3. **对每个成员的 `agent_ref`：**
   - 把 ref 解析到一个智能体 spec 目录
   - 拷贝智能体 spec 及其全部资源（skills、guidance、hooks、startup、运行时资源）
   - 递归解析并拷贝 import
   - 在 manifest 里记录该智能体条目及其哈希
   - 把 ref 重写为 bundle 相对 `local:` 路径
4. **把重写后的工作组 spec**写到暂存目录
5. **计算完整性** —— 暂存目录每个文件的 SHA-256
6. **写 manifest**（`bundle.yaml`），带所有条目和完整性
7. **打包**暂存目录成确定性 tar.gz

### 终端节点

带 `agent_ref: "builtin:terminal"` 的成员是 bundle 原生哨兵。它们不 vendor——运行时直接处理。

### 去重

如果多个成员引用同一智能体 spec（相同解析路径），该 spec 只 vendor 一次，所有成员的 ref 重写到同一 bundle 相对路径。

### Import 解析

当一个智能体 spec 有 `imports`，每个 import 被解析、vendor 进 bundle，vendor 后 agent.yaml 里的 import ref 重写为 bundle 相对 `local:` 路径。import 条目记录在 manifest 的智能体条目里。

---

## 校验规则汇总

### Manifest 校验（schema 版本 2）

1. `schema_version` 必须为 `2`
2. `name` 必填非空字符串
3. `version` 必填非空字符串
4. `created_at` 必填非空字符串
5. `rig_spec` 必填，必须是安全相对路径
6. `agents` 必须是数组
7. 每个智能体必须有 `name`、`path`（安全相对）和 `hash`
8. 完整性 `algorithm` 必须为 `sha256`
9. 完整性 `files` 必须是非空 map：安全相对路径 → 64 字符十六进制哈希

### 归档安全（解包时强制）

1. 无符号链接或硬链接
2. 无绝对路径
3. 无 `..` 路径穿越
4. 归档摘要必须匹配兄弟 `.sha256`
5. 逐文件内容哈希必须匹配完整性段

### 组装校验

1. 工作组 spec 必须通过校验
2. 所有 `agent_ref` 路径必须解析到合法智能体 spec
3. 所有声明的 `docs` 文件必须在磁盘存在（缺文档组装失败）
4. 文化文件和启动文件尽力收集（缺失 = 跳过）

---

## 旧版 Bundle（Schema 版本 1）

schema 版本 1 bundle 是重启前的格式，用扁平节点工作组 spec 和基于包的打包。它们为向后兼容仍受支持，但不应为新工作组创建。

与 v2 的关键差异：
- manifest 里 `schema_version: 1`
- 用 `packages` 数组而非 `agents` 数组
- 包条目用 `original_source` 而非 `original_ref`
- 包条目无 `import_entries`
- 旧工作组 spec 格式（扁平节点，不是 pod）

---

## 示例：创建并使用 bundle

### 创建

```bash
# 在工作组目录下
zrig bundle create rig.yaml -o my-team.rigbundle --rig-root . --name my-team --bundle-version 1.0.0
```

输出：
```
Bundle created: my-team.rigbundle
  Name: my-team v1.0.0
  Hash: a1b2c3d4e5f6...
```

### 检视

```bash
zrig bundle inspect my-team.rigbundle
```

输出：
```
Bundle: my-team v1.0.0
Digest valid: true
Integrity: PASS
```

### 安装并启动

```bash
cd ~/projects/my-project
zrig up /path/to/my-team.rigbundle
```

等价的显式形式：

```bash
zrig up /path/to/my-team.rigbundle --target ~/projects/my-project
```

bundle 被解压到临时目录、校验完整性、打包文件装进目标根、然后用 bundle 里所有智能体和资源 bootstrap 该工作组。如果你还想让智能体那次运行用不同工作目录启动，单独传 `--cwd <dir>`。
