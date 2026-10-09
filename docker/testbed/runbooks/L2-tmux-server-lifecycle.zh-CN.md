# L2——tmux server 生命周期（脱离后存活、多窗格、send-keys + capture 往返）

**在主机侧、完成 L1 后运行。** 证明承载整个产品的 tmux server 能在容器内正常工作：会话在客户端脱离后继续存活，多个窗格可以共存，且 send-keys → capture 往返能返回完全一致的字节。

## 设置

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l2-${GIT_SHA:0:8}"; docker run -d -t --name "${NAME}" "${IMAGE}"
```

## L2.1——server 在客户端脱离后继续存活

```bash
docker exec "${NAME}" tmux new-session -d -s l2 -x 80 -y 24
docker exec "${NAME}" tmux send-keys -t l2 'echo persist-marker-$$ > /tmp/l2.marker' Enter
sleep 1
# A detached session is the default with -d; confirm the server + session still list after a beat.
docker exec "${NAME}" tmux ls | tee "${EVID}/L2-sessions.txt"
docker exec "${NAME}" cat /tmp/l2.marker | tee "${EVID}/L2-marker.txt"
```

**PASS：** `tmux ls` 显示 `l2` 仍在运行，且 marker 文件存在。**FAIL：** 出现 `no server running` 或找不到 `l2`。

## L2.2——多个窗格

```bash
docker exec "${NAME}" tmux split-window -t l2 -h
docker exec "${NAME}" tmux list-panes -t l2 -F '#{pane_index}' | tee "${EVID}/L2-panes.txt"
```

**PASS：** 至少有两个窗格索引（`0`、`1`）。**FAIL：** 只有一个窗格或命令报错。

## L2.3——send-keys + capture 往返（精确字节）

```bash
TOKEN="roundtrip-$(date +%s 2>/dev/null || echo fixed)-marker"
docker exec "${NAME}" tmux send-keys -t l2.0 "printf '%s\n' '${TOKEN}'" Enter
sleep 1
docker exec "${NAME}" tmux capture-pane -p -t l2.0 | tee "${EVID}/L2-roundtrip.txt"
```

**PASS：** 捕获内容逐字包含 `${TOKEN}`，证明准确字节通过 server 完成往返。**FAIL：** token 缺失或乱码。

## 拆除与证据

```bash
docker rm -f "${NAME}" >/dev/null
{ grep -q 'l2' "${EVID}/L2-sessions.txt" && [ "$(wc -l < "${EVID}/L2-panes.txt")" -ge 2 ] && grep -q "${TOKEN}" "${EVID}/L2-roundtrip.txt" \
  && echo "VERDICT: PASS — server survives detach, multi-pane, exact round-trip" \
  || echo "VERDICT: FAIL — see L2-*.txt"; } | tee "${EVID}/L2-verdict.txt"
```
