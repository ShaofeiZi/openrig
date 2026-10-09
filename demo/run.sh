#!/bin/bash
set -euo pipefail

echo "=== Rigged North Star 演示 ==="
echo ""

# 启动后台服务。
echo "正在启动后台服务..."
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

# 启动演示拓扑。
echo ""
echo "正在启动演示拓扑..."
UP_OUTPUT=$(zrig up demo/rig.yaml)
printf '%s\n' "$UP_OUTPUT"
RIG_ID=$(printf '%s\n' "$UP_OUTPUT" | sed -n -E 's/^(Rig|工作组): //p' | tail -n1)
if [ -z "$RIG_ID" ]; then
  echo "错误：无法从 'zrig up' 输出中确定工作组 ID。" >&2
  exit 1
fi

# 显示节点状态。
echo ""
echo "节点状态："
# OPR.0.4.4.21：在托管会话之外使用 --nodes 时必须显式指定目标。
zrig ps --nodes --rig "$RIG_ID"

# 为演示工作组建立可安全恢复的基线。
echo ""
echo "正在检查原生恢复基线..."
if npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID"; then
  echo "原生恢复基线已就绪。"
else
  echo ""
  echo "新建 Claude 会话尚不能安全恢复；正在为每个智能体填充一轮预热消息..."
  npx tsx demo/scripts/seed-resume-baseline.ts --rig "$RIG_ID" --max-rounds 1
fi

echo ""
echo "最终基线状态："
npx tsx demo/scripts/check-demo-health.ts --rig "$RIG_ID"
npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID"

echo ""
echo "=== 演示拓扑正在运行 ==="
echo "仪表盘：http://localhost:5173"
echo ""
echo "后续步骤："
echo "  zrig ps --nodes --rig '$RIG_ID'   # 检查节点状态"
echo "  zrig down $RIG_ID        # 拆除（自动创建快照）"
echo "  zrig restore <snapshotId> --rig $RIG_ID   # 恢复刚创建的准确快照"
