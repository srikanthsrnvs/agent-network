#!/usr/bin/env bash
# Setup script for the Codex cloud environment of the swarm agent "codex".
# Needs (set in Codex's environment settings):
#   variable SWARM_GATEWAY_HOST   the HTTPS gateway hostname of the box, e.g. words-words-words.trycloudflare.com
#                                 (= contents of ~/.config/agent-network/codex_gateway_host on the Mac; current value
#                                 on the box in ~/swarm/codex/GATEWAY — it changes when the quick tunnel restarts)
#   secret   CODEX_GATEWAY_TOKEN  bearer token that reaches ONLY the swarm-codex sandbox
#                                 (= contents of ~/.config/agent-network/codex_gateway_token on the Mac)
# Internet access for the agent phase: on (unrestricted, or at least *.trycloudflare.com). No cloudflared, no ssh:
# every codex/bin/sc call is one plain HTTPS POST to the gateway, which runs the command inside the sandbox.
# The old SSH path (CODEX_SSH_KEY secret, SWARM_TUNNEL_HOST variable, `ssh swarmbox`, cloudflared access) is NO
# LONGER NEEDED: Codex's egress proxy blocks the WebSocket upgrade that cloudflared access requires.
# No XMTP domains needed: this agent never runs the network stack itself — everything happens on the box.
set -euo pipefail
: "${SWARM_GATEWAY_HOST:?set the SWARM_GATEWAY_HOST variable}" "${CODEX_GATEWAY_TOKEN:?set the CODEX_GATEWAY_TOKEN secret}"
command -v python3 >/dev/null || { echo "python3 is required by codex/bin/sc" >&2; exit 1; }
chmod +x "$(dirname "$0")/bin/"*
"$(dirname "$0")/bin/sc" 'echo "sandbox reachable: $(hostname) as $(whoami); GPUs: $(nvidia-smi -L | wc -l)"'
