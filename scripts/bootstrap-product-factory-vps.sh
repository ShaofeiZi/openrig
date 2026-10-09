#!/usr/bin/env bash
# OPR.0.4.4.13 FR-3 —— product-factory VPS 引导（在 VPS 本机上运行）。
#
# 从全新 Ubuntu 到“工厂就绪”：把冒烟测试里手动跑通的流程产品化。
#
# 用法（在全新 Ubuntu 22.04/24.04 VPS 上以 root 运行）：
#   ./bootstrap-product-factory-vps.sh --artifact <@openrig/cli@X.Y.Z | /path/to/openrig-cli.tgz> \
#     --authorized-key "ssh-ed25519 AAAA... operator@home" [--ts-authkey tskey-...]
#
# 脚本刻意分成多步且输出详尽；每一步都可安全重跑。
# 它绝不打印任何机密材料。有意没有提供 `rig host bootstrap` 子命令
# （host 子命令封顶为 add/list/doctor）——本脚本 + 运行手册就是引导路径；
# 契约是可观察的终态：home-base 上 `rig host doctor <id>` 全绿。

set -euo pipefail

ARTIFACT=""
AUTHORIZED_KEY=""
TS_AUTHKEY="${TS_AUTHKEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --authorized-key) AUTHORIZED_KEY="$2"; shift 2 ;;
    --ts-authkey) TS_AUTHKEY="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[[ -n "$ARTIFACT" ]] || { echo "必须提供 --artifact（@openrig/cli@X.Y.Z 或打包好的 tarball 路径）" >&2; exit 1; }
[[ -n "$AUTHORIZED_KEY" ]] || { echo "必须提供 --authorized-key（home-base 的公钥）" >&2; exit 1; }
[[ "$(id -u)" == "0" ]] || { echo "请以 root 运行（全新 VPS 引导）" >&2; exit 1; }

step() { echo; echo "==> $*"; }

step "1/8 新建无 root 权限的 openrig 用户（仅密钥登录）"
if ! id -u openrig >/dev/null 2>&1; then
  adduser --disabled-password --gecos "OpenRig factory" openrig
  usermod -aG sudo openrig
  echo "openrig ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-openrig
  chmod 0440 /etc/sudoers.d/90-openrig
fi
install -d -m 0700 -o openrig -g openrig /home/openrig/.ssh
grep -qF "$AUTHORIZED_KEY" /home/openrig/.ssh/authorized_keys 2>/dev/null \
  || echo "$AUTHORIZED_KEY" >> /home/openrig/.ssh/authorized_keys
chown openrig:openrig /home/openrig/.ssh/authorized_keys
chmod 0600 /home/openrig/.ssh/authorized_keys

step "2/8 sshd 加固 drop-in（与冒烟测试完全一致的姿态）"
cat > /etc/ssh/sshd_config.d/99-openrig-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
EOF
sshd -t && systemctl reload ssh

step "3/8 UFW：默认拒绝入站；放行 tailnet 入口"
apt-get update -qq && apt-get install -y -qq ufw >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 >/dev/null
# 引导逃生口：在确认 Tailscale SSH 路径可用之前，先保留公网 SSH 开放，
# 之后再移除（见运行手册步骤；姿态检查会标记它）。
ufw allow OpenSSH >/dev/null || true
ufw --force enable >/dev/null
ufw status verbose

step "4/8 Tailscale（tag:openrig-vps；不接路由、不用出口节点、不开 ts-ssh）"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if [[ -n "$TS_AUTHKEY" ]]; then
  tailscale up --authkey "$TS_AUTHKEY" --advertise-tags=tag:openrig-vps --accept-routes=false
else
  echo "   （未提供 --ts-authkey；请交互运行 'tailscale up --advertise-tags=tag:openrig-vps --accept-routes=false'）"
fi
tailscale set --ssh=false >/dev/null 2>&1 \
  || echo "   （跳过关闭 Tailscale SSH；tailscale up 之后请运行：tailscale set --ssh=false）"

step "5/8 Node 22 + tmux（LTS——CLI 的 ABI 守卫会拒绝奇数主版本）"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0] % 2')" != "0" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v tmux >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq tmux >/dev/null
fi
node --version
tmux -V

step "6/8 从已发布产物安装 OpenRig（不手动改包）"
sudo -u openrig -H bash -lc "npm install -g '$ARTIFACT' || sudo npm install -g '$ARTIFACT'"
sudo -u openrig -H bash -lc "rig --version"

step "7/8 daemon + kernel"
sudo -u openrig -H bash -lc "rig daemon start --no-kernel && sleep 2 && rig daemon status"
sudo -u openrig -H bash -lc "rig up kernel || true"   # 裸工厂上 kernel spec 是可选的

step "8/8 完成 —— home-base 侧步骤"
cat <<'EOF'

VPS 侧已完成。现在从 HOME BASE 执行：
  1. rig host add --id <id> --transport ssh --target <tailnet-别名或IP> --user openrig
  2. rig host doctor <id>                       # 期望全绿
  3. rig host doctor <id> --posture product-factory-vps [--public-addr <公网IP>]
  4. 确认 tailnet 路径可用后，移除公网 SSH 逃生口：
       sudo ufw delete allow OpenSSH            # 在 VPS 上执行
EOF
