#!/usr/bin/env bash
# Add an agent to the swarm on the box: identity, memory, names.json everywhere, limits, prompt, sandbox.
#   swarm/add-agent.sh <name> [--mem 48g] [--cpus 16] [--lane "text" | --lane-file f | --prompt f] [--no-container]
# Names are lowercase letters/digits. The new name is visible to every running agent within seconds
# (names.json is re-read on change); the new agent still has to `join swarm` itself at launch.
set -euo pipefail
SWARM=${SWARM_DIR:-$HOME/swarm}; REPO=${REPO:-$HOME/agent-network}; KIT=$SWARM/prompt-kit
name=${1:?name}; shift
[[ "$name" =~ ^[a-z][a-z0-9]{1,15}$ ]] || { echo "bad name: $name" >&2; exit 1; }
mem=48g; cpus=16; lane=""; prompt=""; container=1
while [ $# -gt 0 ]; do case "$1" in
  --mem) mem=$2; shift 2;; --cpus) cpus=$2; shift 2;; --lane) lane=$2; shift 2;; --lane-file) lane=$(cat "$2"); shift 2;;
  --prompt) prompt=$2; shift 2;; --no-container) container=0; shift;; *) echo "unknown flag $1" >&2; exit 1;; esac; done
jq -e --arg n "$name" 'has($n)' "$SWARM/names.json" >/dev/null && { echo "$name already exists in names.json" >&2; exit 1; }
mkdir -p "$SWARM/$name"/{home,memory,work,pi/agent/extensions,.ccache}
addr=$(cd "$REPO" && AGENT_HOME="$SWARM/$name/home" npx tsx -e "import('./packages/client/src/keystore.ts').then(m=>console.log(m.loadOrCreateKeystore().address))" 2>/dev/null | tail -1)
[[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "key generation failed: $addr" >&2; exit 1; }
chmod 600 "$SWARM/$name/home/key"
MEMORY_DIR="$SWARM/$name/memory" "$HOME/.optmem/memo" init >/dev/null 2>&1 || true
tmp=$(mktemp); jq --arg n "$name" --arg a "$addr" '. + {($n): $a}' "$SWARM/names.json" > "$tmp" && mv "$tmp" "$SWARM/names.json"
for h in "$SWARM"/*/home; do cp "$SWARM/names.json" "$h/names.json"; done
grep -qx "$name" "$SWARM/agents.txt" 2>/dev/null || echo "$name" >> "$SWARM/agents.txt"
grep -q "^$name " "$SWARM/limits.conf" 2>/dev/null || echo "$name $mem $cpus" >> "$SWARM/limits.conf"
if [ -n "$prompt" ]; then [ "$(realpath "$prompt")" = "$(realpath -m "$SWARM/prompts/$name.md")" ] || cp "$prompt" "$SWARM/prompts/$name.md"
else
  [ -n "$lane" ] || lane="GENERALIST. Read /swarm/shared/BOARD.md, find the most valuable unclaimed or stalled task, claim it in the room and do it; reproduce others' key measurements; review the RUNBOOK."
  awk -v name="$name" -v lane="$lane" '{ gsub(/\{\{NAME\}\}/, name); gsub(/\{\{LANE\}\}/, lane); print }' "$KIT/prompt.template.md" > "$SWARM/prompts/$name.md"
fi
[ -f "$SWARM/$name/pi/agent/models.json" ] || cp "$SWARM/pi-seed/models.json" "$SWARM/$name/pi/agent/models.json" 2>/dev/null || true
[ -f "$SWARM/$name/pi/agent/settings.json" ] || cp "$SWARM/pi-seed/settings.json" "$SWARM/$name/pi/agent/settings.json" 2>/dev/null || true
[ $container = 1 ] && "$REPO/swarm/swarmctl" create "$name"
echo "added $name = $addr (mem $mem, cpus $cpus); prompt $SWARM/prompts/$name.md"
echo "launch a pi agent:   $REPO/swarm/swarmctl launch $name     (then: swarmctl screen $name)"
echo "or drive it yourself: AGENT_HOME=$SWARM/$name/home AGENT_NAME=$name KEEPER_ADDRESS=\$(cat $SWARM/keeper/address) npx tsx $REPO/swarm/netcli.ts join swarm"
