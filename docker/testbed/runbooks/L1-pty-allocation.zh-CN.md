# L1——PTY 分配（`docker run -t` + tmux capture 返回真实字节；resize 能够传递）

**在主机侧、完成 L0 和构建后运行。** 证明镜像提供了真实 PTY，且其中的 tmux 能产生真实捕获字节——这是对 TUI spike 固定视口模式的复用。绝不要凭记忆断言可观察结果；必须根据实际捕获字节作出结论。

## 设置

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
docker image inspect "${IMAGE}" >/dev/null   # built by scripts/build-testbed-image.sh (FAIL loudly if absent)
NAME="orig-l1-${GIT_SHA:0:8}"
```

## L1.1——分配 PTY 并在容器内启动 tmux 会话

```bash
# -t allocates a PTY; the entrypoint (tini) holds the container. Detached, fixed 80x24 viewport.
docker run -d -t --name "${NAME}" "${IMAGE}"
docker exec "${NAME}" tmux new-session -d -s l1 -x 80 -y 24
docker exec "${NAME}" tmux send-keys -t l1 'printf "PTY-OK:%s\n" "$TERM"; tty' Enter
sleep 1
docker exec "${NAME}" tmux capture-pane -p -t l1 | tee "${EVID}/L1-capture.txt"
```

**PASS：** 捕获内容包含真实的 `PTY-OK:` 行，且 `tty` 输出真实的 pts 设备（`/dev/pts/...`），而不是 `not a tty`。**FAIL：** 出现 `not a tty` 或捕获内容为空。

## L1.2——resize 能够传递

```bash
docker exec "${NAME}" tmux resize-window -t l1 -x 120 -y 40
docker exec "${NAME}" tmux display-message -p -t l1 '#{window_width}x#{window_height}' | tee "${EVID}/L1-resize.txt"
```

**PASS：** 输出 `120x40`，说明尺寸变化已传递到容器内 tmux。**FAIL：** 仍为 `80x24`。

## 拆除与证据

```bash
docker rm -f "${NAME}" >/dev/null
{ grep -q 'PTY-OK:' "${EVID}/L1-capture.txt" && grep -q '/dev/pts/' "${EVID}/L1-capture.txt" && grep -q '120x40' "${EVID}/L1-resize.txt" \
  && echo "VERDICT: PASS — PTY allocated, real capture bytes, resize propagated" \
  || echo "VERDICT: FAIL — see L1-capture.txt / L1-resize.txt"; } | tee "${EVID}/L1-verdict.txt"
```

**约束：** 不使用 `-v` 挂载真实 HOME 或工作区；容器用完即弃，拥有全新的 HOME。
