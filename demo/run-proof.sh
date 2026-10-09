#!/bin/bash
set -euo pipefail

PROOF_DIR="demo/proof"
mkdir -p "$PROOF_DIR"

echo "=== Rigged North Star 验证包 ==="
echo "正在 $PROOF_DIR/ 中生成验证产物"
echo ""

# 0. 启动或复用后台服务。
echo "步骤 0：确保后台服务正在运行..."
if zrig daemon start; then
  sleep 2
else
  echo "后台服务启动返回非零状态；正在检查是否已有健康的后台服务..."
  if zrig ps --json >/dev/null 2>&1; then
    echo "复用现有的健康后台服务。"
  else
    echo "错误：后台服务启动失败，且没有可用的健康后台服务。" >&2
    exit 1
  fi
fi
echo ""

# 1. 启动。
echo "步骤 1：启动演示拓扑..."
UP_OUTPUT=$(zrig up demo/rig.yaml 2>&1 | tee "$PROOF_DIR/up-transcript.txt")
RIG_ID=$(printf '%s\n' "$UP_OUTPUT" | sed -n -E 's/^(Rig|工作组): //p' | tail -n1)
if [ -z "$RIG_ID" ]; then
  echo "错误：启动输出中没有工作组 ID，验证失败。"
  exit 1
fi
echo ""

# 2. 节点状态。
echo "步骤 2：启动后的节点状态..."
# OPR.0.4.4.21：在托管会话之外使用 --nodes 时必须显式指定目标。
zrig ps --nodes --rig "$RIG_ID" 2>&1 | tee "$PROOF_DIR/ps-nodes.txt"
echo ""

# 3. 启动后的健康检查。
echo "步骤 3：检查启动后的健康状态..."
npx tsx demo/scripts/check-demo-health.ts --rig "$RIG_ID" --json 2>&1 | tee "$PROOF_DIR/health-after-boot.json"
echo ""

# 4. 启动后立即验证原生恢复。
echo "步骤 4：启动后立即验证原生恢复能力..."
if npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID" --output "$PROOF_DIR/native-resume-after-boot.json" 2>&1 | tee "$PROOF_DIR/native-resume-after-boot.txt"; then
  echo "启动后原生恢复基线已就绪。"
  cat > "$PROOF_DIR/seed-resume-baseline.txt" <<'EOF'
跳过基线填充：启动后原生恢复基线已就绪。
EOF
  cat > "$PROOF_DIR/seed-resume-baseline.json" <<'EOF'
{
  "skipped": true,
  "reason": "native resume baseline was already ready after boot"
}
EOF
else
  echo ""
  echo "步骤 5：填充恢复基线..."
  npx tsx demo/scripts/seed-resume-baseline.ts --rig "$RIG_ID" --max-rounds 1 --output "$PROOF_DIR/seed-resume-baseline.json" 2>&1 | tee "$PROOF_DIR/seed-resume-baseline.txt"
fi
echo ""

# 5. 停止前验证原生恢复。
echo "步骤 6：停止前验证原生恢复能力..."
npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID" --output "$PROOF_DIR/native-resume-before-down.json" 2>&1 | tee "$PROOF_DIR/native-resume-before-down.txt"
echo ""

# 6. 使用已捕获的工作组 ID 执行停止/恢复。
echo "工作组 ID：$RIG_ID"

# 7. 拆除。
echo ""
echo "步骤 7：拆除..."
DOWN_OUTPUT=$(zrig down "$RIG_ID" 2>&1 | tee "$PROOF_DIR/down-transcript.txt")
SNAPSHOT_ID=$(printf '%s\n' "$DOWN_OUTPUT" | sed -n -E 's/^(Snapshot|快照): //p' | tail -n1)
if [ -z "$SNAPSHOT_ID" ]; then
  echo "错误：拆除输出中没有快照 ID，验证失败。"
  exit 1
fi
echo "快照 ID：$SNAPSHOT_ID"
echo ""

# 8. 验证没有孤立 tmux 会话。
echo "步骤 8：检查孤立会话..."
tmux ls 2>&1 | tee "$PROOF_DIR/tmux-check.txt" || echo "没有运行中的 tmux server（干净）" | tee "$PROOF_DIR/tmux-check.txt"
echo ""

# 9. 使用显式快照和工作组 ID 恢复。
echo "步骤 9：使用显式快照和工作组 ID 恢复..."
zrig restore "$SNAPSHOT_ID" --rig "$RIG_ID" 2>&1 | tee "$PROOF_DIR/restore-transcript.txt"
echo ""

# 10. 恢复后的节点状态。
echo "步骤 10：恢复后的节点状态..."
zrig ps --nodes --rig "$RIG_ID" 2>&1 | tee "$PROOF_DIR/ps-restored.txt"
echo ""

echo "=== 自动验证产物已生成 ==="
echo ""
echo "剩余手动步骤："
echo "  1. 在浏览器中打开 http://localhost:5173"
echo "     截取 Explorer + Graph + Detail Panel"
echo "     保存到：$PROOF_DIR/browser-screenshot.png"
echo ""
echo "  2. 运行：tmux attach -t orch-lead@demo-rig"
echo "     询问：'你刚才在做什么？'"
echo "     将回答复制到：$PROOF_DIR/resume-test.txt"
echo ""
echo "验证产物："
ls -la "$PROOF_DIR/"
