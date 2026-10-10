#!/usr/bin/env bash
# Setup script for the Codex cloud environment of the swarm agent "codex".
# Needs (set in Codex's environment settings):
#   secret   CODEX_SSH_KEY      private key of the locked-down `codex` user on the Threadripper (paste the whole file)
#   variable SWARM_TUNNEL_HOST  the tunnel hostname of the box, e.g. words-words-words.trycloudflare.com
# Network allowlist for the agent phase: *.trycloudflare.com, github.com, objects.githubusercontent.com,
# release-assets.githubusercontent.com. No XMTP domains: this agent never runs the network stack itself —
# everything happens on the box through `ssh swarmbox` (every session lands inside the swarm-codex sandbox).
set -euo pipefail
CF=$(command -v cloudflared || true)
if [ -z "$CF" ]; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  if (sudo -n dpkg -i /tmp/cloudflared.deb || dpkg -i /tmp/cloudflared.deb) >/dev/null 2>&1; then CF=$(command -v cloudflared)
  else mkdir -p ~/.local/bin && dpkg-deb -x /tmp/cloudflared.deb /tmp/cf && cp /tmp/cf/usr/bin/cloudflared ~/.local/bin/ && CF=$HOME/.local/bin/cloudflared; fi
fi
"$CF" --version
: "${CODEX_SSH_KEY:?set the CODEX_SSH_KEY secret}" "${SWARM_TUNNEL_HOST:?set the SWARM_TUNNEL_HOST variable}"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%b\n' "${CODEX_SSH_KEY//\\n/$'\n'}" > ~/.ssh/codex_swarm && chmod 600 ~/.ssh/codex_swarm   # tolerate a key pasted as one line with \n
cat > ~/.ssh/config <<CFG
Host swarmbox
  HostName ${SWARM_TUNNEL_HOST}
  User codex
  IdentityFile ~/.ssh/codex_swarm
  ProxyCommand ${CF} access ssh --hostname %h
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ConnectTimeout 20
CFG
chmod 600 ~/.ssh/config
chmod +x "$(dirname "$0")/bin/"*
ssh swarmbox 'echo "sandbox reachable: $(hostname) as $(whoami); GPUs: $(nvidia-smi -L | wc -l)"'
