#!/bin/bash
# Rebuild covered/remaining distinct path sets from verification-logs/*.log
# Usage: bash rebuild-coverage.sh
set -e
cd "$(dirname "$0")/../../.."
B2=".codex/translation/review-2026-10-08-batch2"
OUT="$B2"

# 1. disk total (bare filenames, scripts stripped)
find packages/*/test scripts -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs' 2>/dev/null \
  | sed 's|^scripts/||;s|.*/test/||' | sort -u > "$OUT/disk-base.txt"

# 2. covered from vitest logs (test/<name>)
grep -hoE 'test/[A-Za-z0-9_.-]+\.test\.tsx?' "$B2/verification-logs/"*.log 2>/dev/null \
  | sed 's|test/||' | sort -u > "$OUT/cov-vitest.txt"

# 3. covered from scripts logs (node --test) — any scripts/*.test.mjs mentioned in b2-92
grep -hoE 'scripts/[A-Za-z0-9_.-]+\.test\.mjs' "$B2/verification-logs/"*.log 2>/dev/null \
  | sed 's|scripts/||' | sort -u > "$OUT/cov-scripts.txt"

# 4. union covered
cat "$OUT/cov-vitest.txt" "$OUT/cov-scripts.txt" | sort -u > "$OUT/cov-covered.txt"

# 5. remaining = disk - covered
comm -23 "$OUT/disk-base.txt" "$OUT/cov-covered.txt" > "$OUT/remaining-distinct.txt"

echo "disk total:    $(wc -l < $OUT/disk-base.txt)"
echo "covered:       $(wc -l < $OUT/cov-covered.txt)"
echo "remaining:     $(wc -l < $OUT/remaining-distinct.txt)"
echo "--- remaining ---"
cat "$OUT/remaining-distinct.txt"
