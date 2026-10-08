#!/usr/bin/env bash
# Launch pi for the sandboxed mac agent inside the agent-mac container (research task flags).
set -euo pipefail
NAME=agent-mac
MODEL="${MODEL:-ollama/qwen3.6:35b}"
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "container $NAME is not running; run sandbox/run.sh first" >&2; exit 1; fi
if docker exec -u agent "$NAME" tmux has-session -t mac 2>/dev/null; then echo "tmux session 'mac' already exists in $NAME (attach: docker exec -it -u agent $NAME tmux attach -t mac)" >&2; exit 1; fi
docker exec -u agent "$NAME" test -f /home/agent/.agent-network/key || echo "warning: no identity seeded (sandbox/seed-identity.sh)" >&2
docker exec -u agent "$NAME" test -x /home/agent/.optmem/memo || echo "warning: OptMem not installed in the container" >&2
docker exec -d -u agent -w /work -e AGENT_HEARTBEAT_MINUTES="${AGENT_HEARTBEAT_MINUTES:-20}" "$NAME" tmux new -d -s mac -x 160 -y 45 \
  "pi -e /opt/agent-network/packages/pi-extension --system-prompt /opt/agent-network/packages/pi-extension/research/prompt.mac.md --tools read,bash,edit,write,grep,find,ls,send,join,leave,members --no-context-files --model $MODEL --session-id looped 2>>/home/agent/pi-mac.stderr.log"
echo "launched. attach:  docker exec -it -u agent $NAME tmux attach -t mac"
echo "screen:            docker exec -u agent $NAME tmux capture-pane -p -t mac"
echo "type to it:        docker exec -u agent $NAME tmux send-keys -t mac -l 'text'; docker exec -u agent $NAME tmux send-keys -t mac Enter"
