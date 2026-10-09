# 为 OpenRig 创建你自己的 Slack 应用（实验性）

> **0.6.0 中的实验特性。** manifest（`zrig slack manifest`）和本设置指南是新的，尚未对着一次真实的应用创建确认过。Slack 连接器本身及其 `setup`、`verify`、`enable`、`disable`、`status` 命令**不是**实验性的。如果这里某一步和 Slack 给你看的不一致，请[开 issue](https://github.com/mvschwarz/openrig/issues/new/choose) 或发 pull request（[CONTRIBUTING.md](../../CONTRIBUTING.md)）。

OpenRig 的 Slack 连接器对接一个你在自己工作区创建的 Slack 应用。OpenRig 随包提供该应用的 manifest；它不托管应用、不跑安装端点、也不发布到 Slack Marketplace。该应用是 Socket Mode 应用，所以它只活在你创建它的那个工作区里。

`zrig slack manifest` 打印 manifest。它离线可用，在任何 daemon 或 token 存在之前：

```bash
zrig slack manifest          # YAML 形式的 manifest
zrig slack manifest --url    # 预填了 manifest 的 Slack 创建应用链接
zrig slack manifest --json   # manifest、它的 scope 和事件，以及每个 scope 为什么被请求
```

Slack 未配置时，TUI 在 Connections 页显示同一个链接。CLI 和 TUI 都不打开浏览器、不接收 token、也不创建应用。

## 步骤

以下是基于 Slack 应用 manifest 文档的预期步骤，尚未对着一次真实创建确认过。Slack 表单可能要求预填没填的东西；那样就跟着表单走。

1. 在浏览器打开 `zrig slack manifest --url` 给出的链接。
2. 如被要求，登录 Slack，选工作区，审阅预填的 manifest，点 **Create**。
3. 在 **Socket Mode** 下确认它已启用；没启用就启用它。
4. 在 **Basic Information → App-Level Tokens** 下，生成一个带 `connections:write` scope 的 token 并复制（它以 `xapp-` 开头）。
5. 把应用安装到工作区，并批准请求的 scope。
6. 在 **OAuth & Permissions** 下，复制 **Bot User OAuth Token**（它以 `xoxb-` 开头）。
7. 把两个 token 放进一个只有你能读的私有 env 文件（`chmod 600`）：

   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

8. 跑 `zrig slack setup --channel <channel-id> --secrets-env-file <path>`，然后 `zrig slack verify`，再 `zrig slack enable`。
9. 把 bot 邀请进你配置的频道（在该频道里 `/invite @OpenRig`）。

## 这个应用请求什么

跑 `zrig slack manifest --json` 看确切清单和每个 scope 的理由。分两组：

- **基线 scope**：发消息、读该应用所在公开频道的消息历史、读频道详情。`zrig slack verify` 会检查这些。
- **功能 scope**：`files:read`（下载别人发的附件）、`files:write`（上传附件到 Slack）、`app_mentions:read`（接收对该应用的 @ 提及）。`zrig slack verify` **不**检查这些，所以 verify 报 READY 不能证明附件或提及会工作。

如果某个功能 scope 没被授予，后果因功能而异：

- **附件**（`files:read`、`files:write`）：文件下载或上传调用失败。带一个下不下来的附件的消息仍然投递，并在消息里点名失败文件。一条附件传不上去的 post 仍然投递它的文本，失败只出现在 daemon 日志里（`zrig daemon logs`）。
- **提及**（`app_mentions:read`）：Slack 不向应用投递 `app_mention` 事件，OpenRig 里也没有任何东西报告它们缺失。

所以安装后，把 Slack 给该应用的已授权 scope，和 `zrig slack manifest --json` 列出的全部六个 scope 对一遍。

该应用订阅它所在公开频道的消息（`message.channels`）和对该应用的提及（`app_mention`）。它不请求私信或私有频道访问。

## 连接器拿这些 token 做什么

token 留在你创建的 env 文件里。连接器从那个文件读它们，用来向 Slack 认证：它用 app-level token 开一条出站 Socket Mode 连接，用 bot token 调 Slack 的 Web API。这个连接器没有 OpenRig 托管组件，只做出站连接。这句话是说这个 Slack 连接器，不是说 OpenRig 的每一部分。

## 下一步

- `zrig slack status` 显示还缺什么，不联系 Slack。
- `zrig slack verify` 对照 Slack 检查已授权的基线 scope 和频道成员身份。
