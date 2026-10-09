# agent-browser：本地开发经验

> 浏览器任务的配套说明。下方命令细节反映 v0.13.0 时期的用法，可能与已安装版本不同。
> 请查看当前 help 并验证目标操作；本文件不是当前浏览器或登录测试凭据。

---

## 命令兼容性矩阵

**并非所有 `get` 子命令都接受 @refs。**这是最常见的困惑来源。

| 命令 | @refs | CSS selectors | 说明 |
|------|-------|---------------|------|
| `get text @e1` | 是 | 是 | 两种方式都可用 |
| `get html` | 否 | 是 | 使用 refs 时静默失败 |
| `get box` | 否 | 是 | 返回 `{x, y, width, height}` JSON |
| `get styles` | 否 | 是 | 返回紧凑摘要（font、color、bg、border-radius） |
| `get value` | 否 | 是 | 用于表单输入 |
| `get attr` | 否 | 是 | 获取任意 HTML attribute |
| `get count` | 不适用 | 是 | 返回元素数量 |
| `get url` | 不适用 | 不适用 | 无需 selector |
| `get title` | 不适用 | 不适用 | 无需 selector |
| `click` | 是 | 是 | 两种方式都可用 |
| `fill` | 是 | 是 | 两种方式都可用 |
| `highlight` | 否 | 是 | skill 展示 `highlight @e1`，但实际会失败 |

**经验法则：**交互命令（click、fill、type、check、select）支持 @refs。检查命令（get html/box/styles、highlight）需要 CSS selectors。

## CSS Selectors：严格模式

Playwright 严格模式要求 CSS selectors **恰好匹配一个元素**。匹配多个元素时会报错，并列出所有匹配项（这对调试其实很有帮助）。

**构造唯一 selector 的策略：**
- 使用 ID：`#fork-button`
- 使用唯一 attribute：`[data-testid="submit"]`
- 组合：`.header > a:first-child`
- 使用 `nth`：`.item:nth-child(3)`

## Ref 生命周期：黄金法则

**任何页面状态变化**都会使 refs 失效，包括：
- 导航（点击链接、`open`、`back`、`forward`）
- 限定范围的 snapshots（`snapshot -s`）← 这一项很容易忘记
- 表单提交
- 动态内容（modals、dropdowns、AJAX loads）
- 即使是 `snapshot` 本身也会替换所有旧 refs

**模式：**交互前始终立即创建 snapshot。绝不要跨越多个会改变页面的操作缓存 refs。

## Snapshot 模式对比

| Flag | 返回内容 | 适用场景 |
|------|----------|----------|
| `-i` | 仅交互元素 | **默认选择**——token 效率最高 |
| `-i -C` | 交互元素 + 光标可交互元素 | 带 onclick 的 div 没有显示时 |
| `-c` | 紧凑模式（移除空节点） | 不可靠——某些网站会返回“Empty page” |
| `-d N` | 限制深度 | `-i` 返回过多内容时 |
| `-s "#sel"` | 限定到 selector | 精准聚焦单个组件 |
| `--json` | JSON 格式 | 程序化解析 |

如果完整 DOM 列表会掩盖任务所需元素，使用交互式或限定范围的 snapshot。

## 带标注的截图

`screenshot --annotate` 功能强大，但在复杂页面上**可能挂起**（已知问题 #509）。如果挂起：
1. 使用 Ctrl-C 或 timeout 终止
2. 回退到普通 `screenshot` + 独立的 `snapshot -i`
3. 该功能最适合较简单的页面

带标注截图还会**缓存 refs**，因此可在截图后立即与元素交互，无需单独 snapshot。

## 网络监控

```bash
# 查看所有请求（从页面打开时起开始捕获）
agent-browser network requests

# 仅过滤 API 调用（大幅减少噪声）
agent-browser network requests --filter "/api/"

# Mock API 响应
agent-browser network route "https://api.example.com/data" --body '{"mocked": true}'

# 阻止请求（例如 analytics）
agent-browser network route "https://www.google-analytics.com/*" --abort
```

请求从会话开始时捕获。在真实网站上，`--filter` flag 至关重要——如果不用，会得到几十条 CSS/图片/analytics 请求。

## JavaScript Eval 模式

```bash
# 快速单行表达式（单引号，无嵌套）
agent-browser eval 'document.title'

# 复杂 JS（含引号、箭头函数或模板字面量时，始终使用 --stdin）
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("a"))
    .map(a => ({ text: a.textContent.trim(), href: a.href }))
    .filter(a => a.text.length > 0)
    .slice(0, 10)
)
EVALEOF

# 从浏览器上下文 Fetch API（使用页面 cookies/auth）
agent-browser eval --stdin <<'EVALEOF'
(async () => {
  const res = await fetch('/api/data');
  return JSON.stringify(await res.json());
})()
EVALEOF
```

## 会话管理

- **完成后始终关闭：**`agent-browser close` 可防止后台服务进程泄漏
- **用于调试的 headed 模式：**`agent-browser --headed open <url>`
- **持久 headed 配置：**将 `{"headed": true}` 添加到 `~/.agent-browser/config.json`
- **用于并行工作的具名会话：**`agent-browser --session name open <url>`

## 认证与保留的浏览器状态

针对目标应用，选择已安装工具支持的 state 或 profile 机制。保存的状态文件或持久 profile 不能证明后续会话仍已认证：重新打开后，应检查目标账户及一项有意义的授权页面或操作。服务器过期和应用策略都可能使保留状态失效。

为任务使用明确归属的 profile。通过用户授权的流程完成所需登录；不要根据本指南假定 profile、账户、应用 URL 或 provider 变通方案。必须根据实际版本和流程检查浏览器/provider 兼容性。本说明不随附已验证登录或已保存 profile。

把 profile 目录和保存状态视为包含凭据的数据。存放在获授权的私有位置，限制访问，并确保源码、普通日志和共享证据中不包含 cookies、tokens、密码和加密密钥。如果配置了加密，应验证真实工具配置和密钥托管；不要仅凭文件名推断已加密，也不要假定 shell 已导出密钥。只保留或移除属于当前任务、且处置方式已获授权的状态。

## 更新官方 Skill

同步 SKILL.md 与上游，同时保留本地经验：

```bash
# 下载最新官方 SKILL.md
curl -sL https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md \
  -o ~/.claude/skills/agent-browser/SKILL.md

# 重新追加本地经验引用（SKILL.md 末尾 3 行）
cat >> ~/.claude/skills/agent-browser/SKILL.md << 'EOF'

## Local Dev Insights
**IMPORTANT:** Read `LOCAL-INSIGHTS.md` in this skill directory for gotchas, corrections, and tested workflows discovered through hands-on use that this upstream skill doesn't cover.
EOF
```
