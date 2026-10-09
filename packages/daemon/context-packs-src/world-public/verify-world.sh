#!/bin/sh

# 唯一可选的外部能力是 rig 本身。在调用任何外部命令前就跳过，使空 PATH 下缺少命令的情形
# 也能得到真实结果。
if ! command -v rig >/dev/null 2>&1; then
  printf '%s\n' '[skip] rig-command-surface——rig 不可用；未评估命令相关声明'
  printf '%s\n' '0 通过 · 0 失败 · 1 跳过'
  exit 0
fi

passed=0
failed=0
skipped=0
case "$0" in
  */*) root=${0%/*} ;;
  *) root=. ;;
esac
root=$(CDPATH= cd "$root" && pwd)
example="$root/../world-example"

pass() {
  passed=$((passed + 1))
  printf '[ok] %s — %s\n' "$1" "$2"
}

fail() {
  failed=$((failed + 1))
  printf '[FAIL] %s — %s\n' "$1" "$2"
}

if grep -Eq '^taxonomy:[[:space:]]*world[[:space:]]*$' "$root/manifest.yaml"; then
  pass pack-taxonomy '包已声明 taxonomy world'
else
  fail pack-taxonomy 'manifest taxonomy 不是 world'
fi

declared_ok=1
for file in boundaries.md boundaries.zh-CN.md build-your-world.md build-your-world.zh-CN.md claims.yaml start-here.md start-here.zh-CN.md verify-world.sh; do
  [ -f "$root/$file" ] || declared_ok=0
  grep -Fq "path: $file" "$root/manifest.yaml" || declared_ok=0
done
if [ "$declared_ok" -eq 1 ]; then
  pass declared-files '每个发布文件都存在且已声明'
else
  fail declared-files '有发布文件缺失或未声明'
fi

manifest_comments_ok=1
for manifest in "$root/manifest.yaml" "$example/manifest.yaml"; do
  grep -Eq '(^|[[:space:]])#[[:space:]]' "$manifest" && manifest_comments_ok=0
done
if [ "$manifest_comments_ok" -eq 1 ]; then
  pass manifest-authored-comments '两份发布 manifest 均不含未纳入清单的人工正文注释'
else
  fail manifest-authored-comments '某份发布 manifest 含未纳入清单的人工正文注释'
fi

regions_ok=1
for region in identity ontology terrain actors laws history state affordances; do
  grep -Eq "regions:.*(^|[^a-z])$region([^a-z]|$)" "$root/manifest.yaml" || regions_ok=0
done
grep -Fq 'The eight regions are metadata on atoms, not a required folder tree.' "$root/build-your-world.md" || regions_ok=0
grep -Fq 'Tag existing authored files with identity, ontology, terrain, actors, laws, history, state, and' "$root/build-your-world.md" || regions_ok=0
grep -Fq 'affordances. One coherent file may cover several regions; do not fork the same idea into eight' "$root/build-your-world.md" || regions_ok=0
if [ "$regions_ok" -eq 1 ]; then
  pass atom-regions 'atom 元数据覆盖全部八个 region'
else
  fail atom-regions 'atom 元数据缺少一个或多个 world region'
fi

coverage_map_ok=1
grep -Fq 'Each coverage entry names one dimension, one exact context address, and the task moment that should trigger the read.' "$root/build-your-world.md" || coverage_map_ok=0
for dimension in product topology context skill 'queue/custody' 'source/worktree' 'proof/review' 'lifecycle/release' 'continuity/recovery' 'host-boundary'; do
  awk -F'|' -v wanted="$dimension" '
    function trim(value) { sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); return value }
    trim($2) == wanted && trim($3) ~ /^`[^`]+`$/ && length(trim($4)) > 0 && length(trim($5)) > 0 { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$root/build-your-world.md" || coverage_map_ok=0
done
if [ "$coverage_map_ok" -eq 1 ]; then
  pass coverage-map-contract '十个维度均包含一个精确地址和一个任务语言触发条件'
else
  fail coverage-map-contract '十维地址/触发条件图不完整或格式错误'
fi

prose=$(cat "$root/start-here.md" "$root/build-your-world.md" "$root/boundaries.md" "$example/your-world.md")
manifest_prose=$(cat "$root/manifest.yaml" "$example/manifest.yaml")
claim_ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/claims.yaml")
expected_markdown_claim_ids='world-purpose
author-derive-rule
derive-identity
derive-topology
discover-context
discover-commands
trust-source-table
agents-complement
minimal-world-layout
authoring-convention
context-kinds
regions-are-tags
coverage-map-contract
retrieve-public-pack
compose-fresh-profile
region-metadata
no-region-selector
derived-reading-cost
book-example-purpose
retrieve-world-example
book-exercise-guidance
book-to-software
software-shaped-bridge
optional-claim-checking-climb
derive-pack-path
run-public-verifier
boundary-coverage
boundary-exclusions
boundary-guidance
private-ref-boundary
world-example-purpose
world-example-install
world-example-authoring
world-example-book-exercise
world-example-regions
world-example-checks'
expected_manifest_claim_ids='public-manifest-purpose
public-manifest-summary-start-here
public-manifest-summary-start-here.zh-CN
public-manifest-summary-build-your-world
public-manifest-summary-build-your-world.zh-CN
public-manifest-summary-boundaries
public-manifest-summary-boundaries.zh-CN
public-manifest-summary-claims
public-manifest-summary-verify-world
public-manifest-probe-enter-the-world-prompt
public-manifest-probe-enter-the-world-expect
public-manifest-probe-author-a-world-prompt
public-manifest-probe-author-a-world-expect
public-manifest-probe-know-the-edges-prompt
public-manifest-probe-know-the-edges-expect
example-manifest-purpose
example-manifest-summary-your-world
example-manifest-summary-your-world.zh-CN
example-manifest-probe-your-world-prompt
example-manifest-probe-your-world-expect'
expected_claim_ids=$(printf '%s\n%s\n' "$expected_markdown_claim_ids" "$expected_manifest_claim_ids")
claim_count=$(printf '%s\n' "$claim_ids" | sed '/^$/d' | wc -l | tr -d ' ')
markdown_claim_count=$(printf '%s\n' "$expected_markdown_claim_ids" | sed '/^$/d' | wc -l | tr -d ' ')
marker_count=$(printf '%s\n' "$prose" | grep -Ec '<!--[[:space:]]*world-claim:[[:space:]]*[a-z0-9-]+[[:space:]]*-->')
disposition_count=$(grep -Ec '^[[:space:]]+(check|flagged):' "$root/claims.yaml")
kind_count=$(grep -Ec '^[[:space:]]+kind:[[:space:]]+(judgment|operational|structural)[[:space:]]*$' "$root/claims.yaml")
claims_ok=1
[ "$claim_ids" = "$expected_claim_ids" ] || claims_ok=0
[ "$markdown_claim_count" -eq "$marker_count" ] || claims_ok=0
[ "$claim_count" -eq "$disposition_count" ] || claims_ok=0
[ "$claim_count" -eq "$kind_count" ] || claims_ok=0
seen=' '
for id in $claim_ids; do
  case "$seen" in *" $id "*) claims_ok=0 ;; esac
  seen="$seen$id "
done
for id in $expected_markdown_claim_ids; do
  printf '%s\n' "$prose" | grep -Fq "<!-- world-claim: $id -->" || claims_ok=0
done
known_checks=' author-derive-rule derive-identity derive-topology rig-command-surface trust-source-table agents-md-complement authoring-convention taxonomy-layout atom-regions coverage-map-contract retrieve-public-pack compose-fresh-profile no-region-selector derived-reading-cost retrieve-world-example derive-pack-path run-public-verifier boundary-coverage boundary-exclusions private-ref-boundary world-example-install world-example-consistency public-manifest-authored-claims example-manifest-authored-claims '
check_ids=$(sed -n 's/^[[:space:]]*check:[[:space:]]*//p' "$root/claims.yaml")
for check_id in $check_ids; do
  case "$known_checks" in *" $check_id "*) ;; *) claims_ok=0 ;; esac
done
statements=$(sed -n 's/^[[:space:]]*statement: "\(.*\)"$/\1/p' "$root/claims.yaml")
while IFS= read -r statement; do
  [ -z "$statement" ] || printf '%s\n%s\n' "$prose" "$manifest_prose" | grep -Fq "$statement" || claims_ok=0
done <<EOF
$statements
EOF
if [ "$claims_ok" -eq 1 ]; then
  pass claim-coverage '固定的人工声明清单均已且仅已标记、陈述和处置一次'
else
  fail claim-coverage '固定声明清单、标记、陈述、检查或处置发生漂移'
fi

has_manifest_block_line() {
  awk -v block="$2" -v wanted="$3" '
    $0 == block { in_block = 1; next }
    in_block && /^  - (path|id):/ { in_block = 0 }
    in_block && $0 == wanted { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

public_manifest_ok=1
grep -Fqx 'purpose: "A portable operating-world primer that derives volatile facts and teaches agents to author their own world."' "$root/manifest.yaml" || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - path: start-here.md' '    summary: "Derive where you are, what to trust, and which context belongs in a world."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - path: build-your-world.md' '    summary: "The minimal authoring convention and a book-world exercise."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - path: boundaries.md' '    summary: "What this public world covers, excludes, and cannot decide."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - path: claims.yaml' '    summary: "Every authored claim mapped to a failing check or an explicit honesty flag."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - path: verify-world.sh' '    summary: "Portable named checks with loud failures and skips."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: enter-the-world' '      prompt: "You just arrived in an unfamiliar OpenRig environment. What do you derive before acting?"' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: enter-the-world' '      expect: "The agent derives its identity, live topology, available context, and command surface instead of guessing."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: author-a-world' '      prompt: "Create a world for a book-writing project without turning the eight regions into folders."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: author-a-world' '      expect: "The agent starts with a small manifest and authored files, tags atoms by region, and keeps other context kinds separate."' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: know-the-edges' '      prompt: "Which gaps can this public world answer, and which still require local sources or human judgment?"' || public_manifest_ok=0
has_manifest_block_line "$root/manifest.yaml" '  - id: know-the-edges' '      expect: "The agent distinguishes public structure from rig-local facts, current state, mission context, and irreversible judgment."' || public_manifest_ok=0
if [ "$public_manifest_ok" -eq 1 ]; then
  pass public-manifest-authored-claims '公开 purpose、文件摘要和 probe 语义与冻结的人工清单一致'
else
  fail public-manifest-authored-claims '公开 manifest 的 purpose、文件摘要或 probe 语义发生漂移'
fi

example_manifest_ok=1
grep -Fqx 'purpose: "A fill-in template showing the anatomy of an OpenRig world pack."' "$example/manifest.yaml" || example_manifest_ok=0
has_manifest_block_line "$example/manifest.yaml" '  - path: your-world.md' '    summary: "A minimal fill-in template for describing an agent'"'"'s world."' || example_manifest_ok=0
has_manifest_block_line "$example/manifest.yaml" '  - id: your-world' '      prompt: "Describe the operating world for a book-writing project."' || example_manifest_ok=0
has_manifest_block_line "$example/manifest.yaml" '  - id: your-world' '      expect: "The agent fills one coherent world file and derives volatile state instead of creating a folder per region."' || example_manifest_ok=0
if [ "$example_manifest_ok" -eq 1 ]; then
  pass example-manifest-authored-claims '示例 purpose、文件摘要和 probe 语义与冻结的人工清单一致'
else
  fail example-manifest-authored-claims '示例 manifest 的 purpose、文件摘要或 probe 语义发生漂移'
fi

if grep -Fq 'Supply the authored relationships no inventory can discover, point at commands for facts that change, and do not memorize a roster, path, count, status, or command list when the live system can answer.' "$root/start-here.md"; then
  pass author-derive-rule '人工关系保持书面记录，可变事实指向实时命令'
else
  fail author-derive-rule '人工编写与派生规则发生漂移'
fi

trust_ok=1
grep -Fq 'Each trust question below names its authoritative source, and a disagreement between authored intent and live state must be investigated rather than silently resolved for convenience.' "$root/start-here.md" || trust_ok=0
grep -Fq '| What is this environment for? | Its authored world and governing intent |' "$root/start-here.md" || trust_ok=0
grep -Fq '| What exists right now? | The command that lists the live system |' "$root/start-here.md" || trust_ok=0
grep -Fq '| What am I doing now? | The current mission and owned work |' "$root/start-here.md" || trust_ok=0
grep -Fq '| How do I perform a repeatable task? | The applicable skill or command help |' "$root/start-here.md" || trust_ok=0
grep -Fq '| Why does a local exception exist? | Local lore and its cited evidence |' "$root/start-here.md" || trust_ok=0
if [ "$trust_ok" -eq 1 ]; then
  pass trust-source-table '所有人工信任关系和分歧规则均仍存在'
else
  fail trust-source-table '某项人工信任关系或分歧规则发生漂移'
fi

boundary_coverage_ok=1
grep -Fq 'This public pack covers only the shared world structure and discovery surfaces listed below.' "$root/boundaries.md" || boundary_coverage_ok=0
grep -Fq -- '- the stable separation between world, lore, skills, and mission context;' "$root/boundaries.md" || boundary_coverage_ok=0
grep -Fq -- '- the eight world regions as atom metadata;' "$root/boundaries.md" || boundary_coverage_ok=0
grep -Fq -- '- the author-versus-derive rule;' "$root/boundaries.md" || boundary_coverage_ok=0
grep -Fq -- '- a small convention for authoring and checking a world;' "$root/boundaries.md" || boundary_coverage_ok=0
grep -Fq -- '- the live commands needed to discover identity, topology, packs, and command help.' "$root/boundaries.md" || boundary_coverage_ok=0
if [ "$boundary_coverage_ok" -eq 1 ]; then
  pass boundary-coverage '完整的公开覆盖边界仍然存在'
else
  fail boundary-coverage '公开覆盖边界发生漂移'
fi

boundary_exclusions_ok=1
grep -Fq 'This public pack does not supply rig-specific reality, current work, local lore, repository instructions, or irreversible judgment.' "$root/boundaries.md" || boundary_exclusions_ok=0
grep -Fq -- '- the purpose, actors, topology, paths, or current state of a particular rig;' "$root/boundaries.md" || boundary_exclusions_ok=0
grep -Fq -- '- the mission you currently own;' "$root/boundaries.md" || boundary_exclusions_ok=0
grep -Fq -- '- local lore earned by a seat or team;' "$root/boundaries.md" || boundary_exclusions_ok=0
grep -Fq -- '- harness-specific repository instructions;' "$root/boundaries.md" || boundary_exclusions_ok=0
grep -Fq -- '- irreversible product or operator judgment.' "$root/boundaries.md" || boundary_exclusions_ok=0
if [ "$boundary_exclusions_ok" -eq 1 ]; then
  pass boundary-exclusions '完整的公开排除边界仍然存在'
else
  fail boundary-exclusions '公开排除边界发生漂移'
fi

authoring_ok=1
grep -Fq 'book-world/' "$root/build-your-world.md" || authoring_ok=0
grep -Fq '  manifest.yaml' "$root/build-your-world.md" || authoring_ok=0
grep -Fq '  world.md' "$root/build-your-world.md" || authoring_ok=0
grep -Fq '  boundaries.md' "$root/build-your-world.md" || authoring_ok=0
grep -Fq 'The manifest names the files. The prose states durable purpose, relationships, and what to trust. Add atoms when the same bytes need situation, runtime, order, or region metadata. Add a claim ledger and verifier when authored statements can drift into consequential lies. Do not add ceremony that has no reader yet.' "$root/build-your-world.md" || authoring_ok=0
grep -Fq 'The full public pack demonstrates the optional claim-checking climb.' "$root/build-your-world.md" || authoring_ok=0
if [ "$authoring_ok" -eq 1 ]; then
  pass authoring-convention '最小文件、atom、声明、验证器与可选升级约定仍然存在'
else
  fail authoring-convention '公开创作约定发生漂移'
fi

if rig --help >/dev/null 2>&1 &&
   rig context list --help >/dev/null 2>&1 &&
   rig context show --help >/dev/null 2>&1 &&
   rig context get --help >/dev/null 2>&1 &&
   rig context profile --help >/dev/null 2>&1 &&
   rig context add --help >/dev/null 2>&1 &&
   rig context rm --help >/dev/null 2>&1; then
  pass rig-command-surface '所有已讲授的 rig 命令都存在于实时 CLI 中'
else
  fail rig-command-surface '某个已讲授的 rig 命令不存在于实时 CLI 中'
fi

public_get_output=$(rig context get world-public 2>/dev/null)
public_get_status=$?
public_get_ok=1
[ "$public_get_status" -eq 0 ] || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Enter the world' || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Build your world' || public_get_ok=0
printf '%s\n' "$public_get_output" | grep -Fq '# Boundaries' || public_get_ok=0
if [ "$public_get_ok" -eq 1 ]; then
  pass retrieve-public-pack 'context get 返回了组装后的公开 world 内容'
else
  fail retrieve-public-pack 'context get 未返回组装后的公开 world 内容'
fi

profile_output=$(rig context profile world-public --situation fresh --json 2>/dev/null)
profile_status=$?
profile_tokens=$(printf '%s\n' "$profile_output" | sed -n 's/.*"totalEstimatedTokens"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | sed -n '1p')
profile_ok=1
[ "$profile_status" -eq 0 ] || profile_ok=0
[ -n "$profile_tokens" ] && [ "$profile_tokens" -gt 0 ] || profile_ok=0
for atom in enter-the-world author-a-world know-the-edges; do
  printf '%s\n' "$profile_output" | grep -Eq "\"atomId\"[[:space:]]*:[[:space:]]*\"$atom\"" || profile_ok=0
done
if [ "$profile_ok" -eq 1 ]; then
  pass compose-fresh-profile 'context profile 返回了 fresh atom 图及派生 token 总数'
else
  fail compose-fresh-profile 'context profile 未返回 fresh atom 图和派生 token 总数'
fi

example_get_output=$(rig context get world-example 2>/dev/null)
example_get_status=$?
example_get_ok=1
[ "$example_get_status" -eq 0 ] || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '# Your world' || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '## Exercise: Book world' || example_get_ok=0
printf '%s\n' "$example_get_output" | grep -Fq '## Checks' || example_get_ok=0
if [ "$example_get_ok" -eq 1 ]; then
  pass retrieve-world-example 'context get 返回了已完成示例的 book-world 模板'
else
  fail retrieve-world-example 'context get 未返回已完成示例的 book-world 模板'
fi

pack_output=$(rig context show world-public --json 2>/dev/null)
pack_status=$?
pack_source_path=$(printf '%s\n' "$pack_output" | sed -n 's/.*"sourcePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p')
pack_source_root=$(CDPATH= cd "$pack_source_path" 2>/dev/null && pwd)
pack_path_ok=1
[ "$pack_status" -eq 0 ] || pack_path_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world-public"' || pack_path_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"builtin"' || pack_path_ok=0
[ "$pack_source_root" = "$root" ] || pack_path_ok=0
if [ "$pack_path_ok" -eq 1 ]; then
  pass derive-pack-path 'context show 将此内置包解析到可用的源路径'
else
  fail derive-pack-path 'context show 未将 world-public 解析到此内置目录'
fi

if [ "$pack_path_ok" -eq 1 ] && [ -f "$pack_source_root/verify-world.sh" ]; then
  pass run-public-verifier '此验证器正从 context show 返回的目录运行'
else
  fail run-public-verifier 'context show 返回的目录不包含此验证器'
fi

list_output=$(rig context list --json 2>/dev/null)
list_status=$?
namespace_ok=1
[ "$list_status" -eq 0 ] || namespace_ok=0
printf '%s\n' "$list_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world-public"' || namespace_ok=0
printf '%s\n' "$pack_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"builtin"' || namespace_ok=0
grep -Fq 'Private world installs remain rig-local under their own refs and are never shadowed by this builtin.' "$root/boundaries.md" || namespace_ok=0
grep -Fq 'This pack is `world-public`.' "$root/boundaries.md" || namespace_ok=0
grep -Fq 'A local world may use a different ref and carry instance-specific' "$root/boundaries.md" || namespace_ok=0
grep -Fq 'substance without inheriting or being replaced by these public bytes.' "$root/boundaries.md" || namespace_ok=0
if printf '%s\n' "$list_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world/install"'; then
  private_output=$(rig context show world/install --json 2>/dev/null)
  private_status=$?
  [ "$private_status" -eq 0 ] || namespace_ok=0
  printf '%s\n' "$private_output" | grep -Eq '"relativePath"[[:space:]]*:[[:space:]]*"world/install"' || namespace_ok=0
  printf '%s\n' "$private_output" | grep -Eq '"sourceType"[[:space:]]*:[[:space:]]*"(user_file|workspace)"' || namespace_ok=0
fi
if [ "$namespace_ok" -eq 1 ]; then
  pass private-ref-boundary '内置包列在 world-public，本地 world 命名空间仍保持本地'
else
  fail private-ref-boundary 'world-public 或本地 world 命名空间投影不真实'
fi

configured_context_root=$(rig config get context.root 2>/dev/null)
configured_context_status=$?
example_install_ok=1
[ "$configured_context_status" -eq 0 ] || example_install_ok=0
[ -n "$configured_context_root" ] || example_install_ok=0
if [ -n "${OPENRIG_CONTEXT_ROOT:-}" ] && [ "$configured_context_root" != "$OPENRIG_CONTEXT_ROOT" ]; then
  example_install_ok=0
fi
rig context add --help >/dev/null 2>&1 || example_install_ok=0
rig context list --help >/dev/null 2>&1 || example_install_ok=0

probe_ref="world-public-verify-$$"
probe_target="$configured_context_root/$probe_ref"
probe_installed=0
cleanup_probe() {
  [ "$probe_installed" -eq 1 ] || return 0
  if rig context rm "$probe_ref" --json >/dev/null 2>&1; then
    probe_installed=0
    return 0
  fi
  rm -rf -- "$probe_target" || return 1
  [ ! -e "$probe_target" ] || return 1
  probe_installed=0
}

if [ "$example_install_ok" -ne 1 ]; then
  :
elif [ -d "$probe_target" ] || printf '%s\n' "$list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
  example_install_ok=0
else
  trap 'cleanup_probe >/dev/null 2>&1 || :' 0
  trap 'cleanup_probe >/dev/null 2>&1 || :; exit 130' 1 2 15

  probe_add_output=$(rig context add "$example" --name "$probe_ref" --json 2>/dev/null)
  probe_add_status=$?
  probe_installed_at=$(printf '%s\n' "$probe_add_output" | sed -n 's/.*"installedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1p')
  [ "$probe_add_status" -eq 0 ] || example_install_ok=0
  [ "$probe_installed_at" = "$probe_target" ] || example_install_ok=0

  probe_list_output=$(rig context list --json 2>/dev/null)
  probe_list_status=$?
  if [ -d "$probe_target" ] || printf '%s\n' "$probe_list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
    probe_installed=1
  fi
  [ "$probe_list_status" -eq 0 ] || example_install_ok=0
  printf '%s\n' "$probe_list_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\"" || example_install_ok=0

  if [ "$probe_installed" -eq 1 ]; then
    cleanup_probe || example_install_ok=0
  fi
  probe_cleanup_output=$(rig context list --json 2>/dev/null)
  probe_cleanup_status=$?
  [ "$probe_cleanup_status" -eq 0 ] || example_install_ok=0
  if [ -d "$probe_target" ] || printf '%s\n' "$probe_cleanup_output" | grep -Eq "\"relativePath\"[[:space:]]*:[[:space:]]*\"$probe_ref\""; then
    example_install_ok=0
  fi
fi
if [ "$example_install_ok" -eq 1 ]; then
  pass world-example-install 'context add 安装示例，list 展示其 ref，清理过程将其移除'
else
  fail world-example-install '类型化 context 存储或讲授的 add/list 效果不真实'
fi

expected_session=${OPENRIG_SESSION_NAME:-${RIGGED_SESSION_NAME:-}}
identity_output=$(rig whoami --json 2>/dev/null)
identity_status=$?
identity_ok=1
[ "$identity_status" -eq 0 ] || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"rigName"[[:space:]]*:[[:space:]]*"[^"]+"' || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"memberId"[[:space:]]*:[[:space:]]*"[^"]+"' || identity_ok=0
printf '%s\n' "$identity_output" | grep -Eq '"sessionName"[[:space:]]*:[[:space:]]*"[^"]+@[^"]+"' || identity_ok=0
if [ -n "$expected_session" ]; then
  printf '%s\n' "$identity_output" | grep -Fq "\"sessionName\":\"$expected_session\"" || identity_ok=0
fi
if [ "$identity_ok" -eq 1 ]; then
  pass derive-identity 'rig whoami 返回了完整的托管席位身份'
else
  fail derive-identity 'rig whoami 未返回完整的托管席位身份'
fi

topology_output=$(rig ps --nodes --json 2>/dev/null)
topology_status=$?
topology_ok=1
[ "$topology_status" -eq 0 ] || topology_ok=0
[ -n "$expected_session" ] || topology_ok=0
printf '%s\n' "$topology_output" | grep -Eq "\"canonicalSessionName\"[[:space:]]*:[[:space:]]*\"$expected_session\"" || topology_ok=0
printf '%s\n' "$topology_output" | grep -Eq '"rigName"[[:space:]]*:[[:space:]]*"[^\"]+"' || topology_ok=0
if [ "$topology_ok" -eq 1 ]; then
  pass derive-topology 'rig ps 节点详情在 canonical session 身份下返回了当前席位'
else
  fail derive-topology 'rig ps 节点详情未在 canonical session 身份下包含当前席位'
fi

if grep -Fq 'rig whoami --json' "$root/start-here.md" &&
   grep -Fq 'rig ps --nodes --json' "$root/start-here.md" &&
   grep -Fq 'rig context list' "$root/start-here.md" &&
   grep -Fq 'rig --help' "$root/start-here.md"; then
  pass taught-commands '可变事实均指向其派生命令'
else
  fail taught-commands '一个或多个派生命令未被讲授'
fi

if grep -Fq 'WORLD + LORE + SKILLS + MISSION' "$root/build-your-world.md" &&
   grep -Fq -- '- WORLD: where the agent is — entities, relationships, rules, history, state sources, affordances.' "$root/build-your-world.md" &&
   grep -Fq -- '- LORE: what a position learned by living there.' "$root/build-your-world.md" &&
   grep -Fq -- '- SKILLS: repeatable procedural capability.' "$root/build-your-world.md" &&
   grep -Fq -- '- MISSION: the current work and why it matters.' "$root/build-your-world.md"; then
  pass taxonomy-layout '创作约定区分了四种 context 类型'
else
  fail taxonomy-layout '缺少四类型分离'
fi

if [ "$profile_ok" -eq 1 ] && [ -n "$profile_tokens" ] && [ "$profile_tokens" -gt 0 ] &&
   grep -Fq "Use the composed profile's reported token total to decide what a future consumer should request; do not cut sentences until" "$root/build-your-world.md" &&
   grep -Fq 'their meaning breaks.' "$root/build-your-world.md"; then
  pass derived-reading-cost "实时组合器报告了正值阅读成本（$profile_tokens 个 token）"
else
  fail derived-reading-cost '实时组合器未报告正值阅读成本'
fi

profile_help=$(rig context profile --help 2>/dev/null)
profile_help_status=$?
if [ "$profile_help_status" -eq 0 ] &&
   ! printf '%s\n' "$profile_help" | grep -Eq -- '--region([[:space:]=]|$)' &&
   grep -Fq 'If a real consumer needs region-subset composition, route that' "$root/build-your-world.md" &&
   grep -Fq 'capability as separate profile-composer work.' "$root/build-your-world.md"; then
  pass no-region-selector '实时 profile 接口没有 region 选择器'
else
  fail no-region-selector '声明的无选择器边界与实时 profile 接口不一致'
fi

if grep -Fq 'If a repository uses AGENTS.md, keep repo instructions there; a world complements those instructions.' "$root/start-here.md" &&
   grep -Fq 'Repository instructions explain how to work in that tree. A world explains the larger operating' "$root/start-here.md" &&
   grep -Fq 'reality: the entities, relationships, rules, history, state sources, and affordances surrounding it.' "$root/start-here.md" &&
   grep -Fq 'Neither replaces the other.' "$root/start-here.md"; then
  pass agents-md-complement 'world 与仓库说明互为补充'
else
  fail agents-md-complement '缺少仓库说明边界'
fi

example_regions_ok=1
for region in identity ontology terrain actors laws history state affordances; do
  grep -Eq "regions:.*(^|[^a-z])$region([^a-z]|$)" "$example/manifest.yaml" || example_regions_ok=0
done
if [ "$example_regions_ok" -eq 1 ] &&
   grep -Fq 'Book world' "$example/your-world.md" &&
   grep -Fq 'rig context get world-example' "$example/your-world.md" &&
   grep -Fq 'rig context add <pack-directory>' "$example/your-world.md" &&
   grep -Fq 'rig context list' "$example/your-world.md" &&
   grep -Fq 'rig config get context.root' "$example/your-world.md" &&
   grep -Fq "Copy this pack, update its manifest, and replace each prompt below with your world's facts." "$example/your-world.md" &&
   grep -Fq 'Run `rig context get world-example`, copy this pack, and make the project a book world by describing the writer, manuscript, sources, editorial rules, decisions, current draft state, and next useful actions in a few coherent files.' "$example/your-world.md" &&
   grep -Fq "Name the world and the agent's place in it." "$example/your-world.md" &&
   grep -Fq 'Define the important kinds of things and what each is for.' "$example/your-world.md" &&
   grep -Fq 'Name who else is present, what they own, and how to reach them.' "$example/your-world.md" &&
   grep -Fq 'Map where code, records, documentation, and operational surfaces live.' "$example/your-world.md" &&
   grep -Fq 'State the durable rules and precedence that govern action here.' "$example/your-world.md" &&
   grep -Fq "Record prior decisions and events that explain the world's current shape." "$example/your-world.md" &&
   grep -Fq 'Point to commands or sources that derive what is true right now.' "$example/your-world.md" &&
   grep -Fq 'List what the agent can do and the trigger for reaching each capability.' "$example/your-world.md" &&
   grep -Fq 'For every checkable authored claim, add a named check that can fail; flag taste or genuinely unverifiable claims instead of dressing judgment up as a test; and derive paths, counts, inventories, and live state from commands rather than copying current answers into this file.' "$example/your-world.md"; then
  pass world-example-consistency '完成示例的练习使用相同 atom 约定'
else
  fail world-example-consistency '完成示例的练习缺失或未分级'
fi

printf '%s 通过 · %s 失败 · %s 跳过\n' "$passed" "$failed" "$skipped"
[ "$failed" -eq 0 ]
