#!/bin/zsh
# Final build + tsc + entry probes. Run ONCE after all authors freeze.
# Serial, single worker, isolated HOME. Captures real rc per step; exits nonzero on any failure.
emulate -L zsh
set -u
cd /Users/bytedance/openrig

B2=".codex/translation/review-2026-10-08-batch2"
ART="$HOME/Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.sessions/38444802165309186/agents/s_000cae4sfcS/artifacts/baseline-2026-10-08"
mkdir -p "$ART/isolated-home/openrig-home"
export HOME="$ART/isolated-home"
export OPENRIG_HOME="$ART/isolated-home/openrig-home"
unset OPENRIG_URL OPENRIG_PORT OPENRIG_HOST RIGGED_URL RIGGED_PORT RIGGED_HOME
unset OPENRIG_NODE_ID OPENRIG_SESSION_NAME OPENRIG_INVOKED_AS

LOG="$B2/verification-logs/final-build-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
fail=0

run_step() {
  local name="$1"; shift
  echo "===== $name $(date '+%H:%M:%S') =====" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  local rc=$?
  echo "----- $name rc=$rc -----" | tee -a "$LOG"
  if [ $rc -ne 0 ]; then fail=1; fi
}

date '+final-start %Y-%m-%dT%H:%M:%S%z' | tee -a "$LOG"

run_step "npm run build" nice -n 10 npm run build
for ws in daemon cli ui tui; do
  run_step "tsc $ws" zsh -c "cd packages/$ws && nice -n 10 ../../node_modules/.bin/tsc --noEmit"
done

# entry probes: single step (probe.js handles rc=1 unknown as expected)
run_step "entry-probe (version/help/unknown for rig|zrig|openrig)" node "$B2/entry-probe.mjs"

date '+final-end %Y-%m-%dT%H:%M:%S%z' | tee -a "$LOG"
echo "OVERALL fail=$fail" | tee -a "$LOG"
exit $fail
