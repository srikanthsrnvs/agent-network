#!/usr/bin/env bash
# Create (or start) the sandbox container for the Mac agent, then seed pi's model config.
#   sandbox/run.sh            create/start `agent-mac`
#   sandbox/run.sh --recreate drop the container (volumes are kept) and create it again
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=agent-network-sandbox
NAME=agent-mac
KEEPER_ADDRESS="$(tr -d '[:space:]' < "$REPO/runs/keeper.address")"
[ -n "$KEEPER_ADDRESS" ] || { echo "runs/keeper.address is empty" >&2; exit 1; }

exists() { docker container inspect "$NAME" >/dev/null 2>&1; }
running() { [ "$(docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }

if [ "${1:-}" = "--recreate" ] && exists; then
  echo "removing container $NAME (volumes agent-mac-home / agent-mac-work are kept)"
  docker rm -f "$NAME" >/dev/null
fi

if exists; then
  have="$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n 's/^KEEPER_ADDRESS=//p')"
  if [ "$have" != "$KEEPER_ADDRESS" ]; then
    echo "container has KEEPER_ADDRESS=$have but runs/keeper.address is $KEEPER_ADDRESS; run with --recreate" >&2
    exit 1
  fi
  running || { echo "starting $NAME"; docker start "$NAME" >/dev/null; }
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "image $IMAGE missing; build it first:" >&2
    echo "  (cd $REPO && docker build --platform linux/arm64 -t $IMAGE -f sandbox/Dockerfile .)" >&2
    exit 1
  }
  echo "creating $NAME"
  # No host bind mounts: the agent sees only its two named volumes.
  docker run -d --name "$NAME" \
    --platform linux/arm64 \
    --restart unless-stopped \
    --memory 4g \
    --add-host host.docker.internal:host-gateway \
    -v agent-mac-home:/home/agent \
    -v agent-mac-work:/work \
    -e AGENT_HOME=/home/agent/.agent-network \
    -e AGENT_NAME=mac \
    -e KEEPER_ADDRESS="$KEEPER_ADDRESS" \
    -e XMTP_ENV=dev \
    "$IMAGE" >/dev/null
fi

# pi config: the host's Ollama through host.docker.internal. Seeded once; edit inside the volume after that.
docker exec -i -u agent "$NAME" sh -c '
  set -e
  mkdir -p ~/.pi/agent ~/.agent-network ~/.ssh && chmod 700 ~/.ssh
  if [ ! -f ~/.pi/agent/models.json ]; then
    cat > ~/.pi/agent/models.json
    echo "seeded ~/.pi/agent/models.json"
  fi
  [ -f ~/.pi/agent/settings.json ] || printf "{\n  \"lastChangelogVersion\": \"0.99.2\"\n}\n" > ~/.pi/agent/settings.json
' <<'JSON'
{
  "providers": {
    "ollama": {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": true,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "qwen3.6:35b",
          "name": "Qwen3.6 35B-A3B",
          "reasoning": true,
          "thinkingLevelMap": { "off": "none", "minimal": "low", "low": "low", "medium": "medium", "high": "high" },
          "input": ["text", "image"],
          "contextWindow": 262144,
          "maxTokens": 16384
        }
      ]
    }
  }
}
JSON

echo "$NAME is running (KEEPER_ADDRESS=$KEEPER_ADDRESS). Shell: docker exec -it -u agent -w /work $NAME bash"
