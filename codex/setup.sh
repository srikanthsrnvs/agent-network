#!/usr/bin/env bash
# Setup script for the Codex cloud environment of the swarm agent "codex".
# Environment secrets/variables it needs (set them in Codex's environment settings):
#   CODEX_SSH_KEY      the private key for the locked-down `codex` user on the Threadripper (paste the whole file)
#   SWARM_TUNNEL_HOST  the tunnel hostname of the box, e.g. words-words-words.trycloudflare.com
# Everything the agent does on the box goes through `ssh swarmbox` (every session lands inside the swarm-codex sandbox).
set -euo pipefail
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  (sudo -n dpkg -i /tmp/cloudflared.deb 2>/dev/null || dpkg -i /tmp/cloudflared.deb) >/dev/null
fi
: "${CODEX_SSH_KEY:?set the CODEX_SSH_KEY secret}" "${SWARM_TUNNEL_HOST:?set SWARM_TUNNEL_HOST}"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%b\n' "${CODEX_SSH_KEY//\\n/$'\n'}" > ~/.ssh/codex_swarm && chmod 600 ~/.ssh/codex_swarm   # tolerate a key pasted as one line with \n
cat > ~/.ssh/config <<CFG
Host swarmbox
  HostName ${SWARM_TUNNEL_HOST}
  User codex
  IdentityFile ~/.ssh/codex_swarm
  ProxyCommand cloudflared access ssh --hostname %h
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ConnectTimeout 20
CFG
chmod 600 ~/.ssh/config
chmod +x "$(dirname "$0")/bin/"*
ssh swarmbox 'echo "sandbox reachable: $(hostname) as $(whoami); GPUs: $(nvidia-smi -L | wc -l)"'
