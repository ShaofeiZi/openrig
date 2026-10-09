#!/usr/bin/env bash
# 二分查找脚本，用于定位哪个测试创建了意外文件/状态。
# 用法：./find-polluter.sh <file_or_dir_to_check> <test_pattern>
# 示例：./find-polluter.sh '.git' 'src/**/*.test.ts'

# 退出码 0：所有选中测试均成功且无污染；1：发现污染源；
# 2：无结果（输入无效、选择失败或测试运行不完整）。
set -eo pipefail

if [ $# -ne 2 ]; then
  echo "用法：$0 <file_to_check> <test_pattern>"
  echo "示例：$0 '.git' 'src/**/*.test.ts'"
  exit 2
fi

POLLUTION_CHECK="$1"
TEST_PATTERN="$2"

echo "🔍 正在查找创建以下目标的测试：$POLLUTION_CHECK"
echo "测试模式：$TEST_PATTERN"
echo ""

# 获取测试文件列表。
if ! TEST_FILES=$(find . -type f -path "./${TEST_PATTERN#./}" | sort); then
  echo "测试选择失败；未运行任何测试。"
  exit 2
fi
if [ -z "$TEST_FILES" ]; then
  echo "没有匹配的测试文件；未运行任何测试。"
  exit 2
fi
TOTAL=$(printf '%s\n' "$TEST_FILES" | wc -l | tr -d ' ')

echo "找到 $TOTAL 个测试文件"
echo ""

COUNT=0
FAILED=0
if [ -e "$POLLUTION_CHECK" ]; then
  echo "测试前污染目标已存在；未运行任何测试。"
  exit 2
fi
while IFS= read -r TEST_FILE; do
  COUNT=$((COUNT + 1))

  echo "[$COUNT/$TOTAL] 正在测试：$TEST_FILE"

  # 运行测试。
  if ! npm test "$TEST_FILE" > /dev/null 2>&1; then
    FAILED=$((FAILED + 1))
    echo "测试运行失败：$TEST_FILE"
  fi

  # 检查是否出现污染。
  if [ -e "$POLLUTION_CHECK" ]; then
    echo ""
    echo "🎯 找到污染源！"
    echo "   测试：$TEST_FILE"
    echo "   创建了：$POLLUTION_CHECK"
    echo ""
    echo "污染详情："
    ls -la "$POLLUTION_CHECK"
    echo ""
    echo "调查方法："
    echo "  npm test $TEST_FILE    # 只运行此测试"
    echo "  cat $TEST_FILE         # 检查测试代码"
    exit 1
  fi
done <<< "$TEST_FILES"

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "未完成：$FAILED 次测试运行失败；未观察到污染源。"
  exit 2
fi
echo "✅ 未发现污染源——$COUNT 次测试运行成功且无污染。"
exit 0
