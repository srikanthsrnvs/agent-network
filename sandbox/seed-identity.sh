#!/usr/bin/env bash
# Copy the host Mac agent's identity (key, names, XMTP db) and the trainbox ssh key into the
# `agent-mac` container. Refuses while the host agent (or the container's agent) is running:
# two clients on one XMTP db corrupt it.
set -euo pipefail

NAME=agent-mac
SRC="${AGENT_HOME:-$HOME/.agent-network}"
DST=/home/agent/.agent-network
KEY_SRC="${TRAINBOX_KEY:-/Users/srikanth/agent-network/runs/trainbox-key/agentnet_ed25519}"

if pgrep -f prompt.mac.md >/dev/null; then
  echo "refusing: the host mac agent is running (pgrep -f prompt.mac.md):" >&2
  pgrep -fl prompt.mac.md >&2
  exit 1
fi
[ "$(docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] || { echo "container $NAME is not running; run sandbox/run.sh first" >&2; exit 1; }
if docker exec -u agent "$NAME" pgrep -f prompt.mac.md >/dev/null 2>&1; then
  echo "refusing: pi is running inside $NAME (tmux session mac). Stop it first." >&2
  exit 1
fi
[ -f "$SRC/key" ] || { echo "no key at $SRC/key" >&2; exit 1; }

docker exec -u agent "$NAME" mkdir -p "$DST" /home/agent/.ssh
copied=()
for f in key names.json xmtp-dev.db3 xmtp-dev.db3-wal xmtp-dev.db3-shm xmtp-dev.db3.sqlcipher_salt xmtp-dev.cursor; do
  if [ -e "$SRC/$f" ]; then
    docker cp "$SRC/$f" "$NAME:$DST/$f"
    copied+=("$f")
  fi
done
# docker cp keeps the host uid (501); hand the files to the agent user and lock the key down.
docker exec -u root "$NAME" sh -c "chown -R agent:agent $DST && chmod 700 $DST && chmod 600 $DST/key && chmod 644 $DST/names.json 2>/dev/null; chmod u+w $DST/xmtp-dev.db3.sqlcipher_salt 2>/dev/null || true"
echo "identity -> $NAME:$DST (${copied[*]})"

if [ -f "$KEY_SRC" ]; then
  docker cp "$KEY_SRC" "$NAME:/home/agent/.ssh/agentnet_ed25519"
  [ -f "$KEY_SRC.pub" ] && docker cp "$KEY_SRC.pub" "$NAME:/home/agent/.ssh/agentnet_ed25519.pub"
  docker exec -i -u root "$NAME" sh -c '
    set -e
    chown -R agent:agent /home/agent/.ssh && chmod 700 /home/agent/.ssh && chmod 600 /home/agent/.ssh/agentnet_ed25519
    touch /home/agent/.ssh/config && chown agent:agent /home/agent/.ssh/config && chmod 600 /home/agent/.ssh/config
    if ! grep -q "^Host trainbox$" /home/agent/.ssh/config; then cat >> /home/agent/.ssh/config; echo "ssh config: added Host trainbox"; fi
  ' <<'SSH'
Host trainbox
  HostName 104.37.174.11
  Port 31989
  User root
  IdentityFile ~/.ssh/agentnet_ed25519
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
SSH
  echo "trainbox key -> $NAME:/home/agent/.ssh/agentnet_ed25519"
else
  echo "no trainbox key at $KEY_SRC yet; rerun this script when it exists (identity part is idempotent)"
fi
