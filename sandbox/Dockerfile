# Sandbox for the Mac agent: pi + the agent-network pi extension, no host filesystem.
# Build from the repo root:  docker build --platform linux/arm64 -t agent-network-sandbox -f sandbox/Dockerfile .
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client python3 python3-venv curl ca-certificates tmux jq ripgrep build-essential \
      procps less vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# uv / uvx into /usr/local/bin so every user has them on PATH
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
    && uv --version

# pi, pinned
RUN npm i -g @earendil-works/pi-coding-agent@0.99.2 && pi --version

# non-root user the agent runs as
RUN useradd -m -s /bin/bash -u 1001 agent \
    && mkdir -p /work /opt/agent-network \
    && chown agent:agent /work /opt/agent-network

# the repo (see .dockerignore at the repo root), built in place
USER agent
COPY --chown=agent:agent . /opt/agent-network
WORKDIR /opt/agent-network
RUN npm ci --no-audit --no-fund && npm run build \
    && node -e 'import("@xmtp/node-sdk").then(()=>console.log("xmtp native binding ok (" + process.arch + ")"))' \
    && rm -rf /home/agent/.npm

WORKDIR /work
CMD ["sleep", "infinity"]
