# Vault 用户

你可以访问由此工作组环境管理的 HashiCorp Vault 实例。

## 连接信息

- **地址：**`http://127.0.0.1:8200`
- **Token：**`openrig-dev-token`
- **认证请求头：**`X-Vault-Token: openrig-dev-token`

发起 API 调用前必须设置 token。使用 curl 时，传入 `-H "X-Vault-Token: openrig-dev-token"`。

## 健康检查

```bash
curl -s http://127.0.0.1:8200/v1/sys/health | jq .
```

健康响应中应包含 `"initialized": true` 和 `"sealed": false`。

## Secret 操作

### 写入 secret

```bash
curl -s -X POST http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token" \
  -d '{"data": {"key": "value"}}' | jq .
```

### 读取 secret

```bash
curl -s http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token" | jq .
```

secret 值位于 `.data.data`。

### 列出 secrets

```bash
curl -s -X LIST http://127.0.0.1:8200/v1/secret/metadata/ \
  -H "X-Vault-Token: openrig-dev-token" | jq .
```

在路径末尾追加目录即可列出子目录：`.../secret/metadata/<prefix>/`。

### 删除 secret

```bash
curl -s -X DELETE http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token"
```

## 解释 Secrets

如果用户要求解释当前 secret 结构，请列出所有路径，并概述每个路径包含的内容。需要时递归调用 list 端点。

## 重要说明

- 当前使用 Vault dev 模式——所有数据仅保存在内存中，重启后会丢失
- dev 模式默认将 KV secrets engine 挂载在 `secret/`
- 直接探测前，先使用 `zrig env status` 命令通过 zrig 验证 Vault 健康状态
