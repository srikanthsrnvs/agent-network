# One sandbox per swarm agent on the Threadripper: CUDA devel toolchain + node + pi + the
# agent-network pi extension + uv + OptMem. Build on the box from the repo root:
#   docker build -t swarm-agent -f swarm/Dockerfile .
# (see .dockerignore at the repo root). x86_64 only.
ARG CUDA_IMAGE=nvidia/cuda:12.9.1-devel-ubuntu24.04
FROM ${CUDA_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client sudo tmux htop jq ripgrep \
      build-essential pkg-config ninja-build ccache python3 python3-venv python3-dev python3-pip \
      libssl-dev libcurl4-openssl-dev zlib1g-dev libgomp1 procps less vim-tiny unzip zstd rsync \
      iproute2 lsof strace file bc \
    && rm -rf /var/lib/apt/lists/*

# recent cmake (Ubuntu 24.04 ships 3.28; some engines want newer)
RUN curl -fsSL https://apt.kitware.com/keys/kitware-archive-latest.asc | gpg --dearmor -o /usr/share/keyrings/kitware.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/kitware.gpg] https://apt.kitware.com/ubuntu/ noble main' > /etc/apt/sources.list.d/kitware.list \
    && apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/* && cmake --version

# node 24 + pi 1.1.0 (the version verified with our extension on the box)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* \
    && npm i -g @earendil-works/pi-coding-agent@1.1.0 && pi --version

# uv / uvx for everyone
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh && uv --version

# the agent user: same uid as the host user so bind-mounted files stay editable on both sides
ARG UID=1000
RUN (getent passwd ${UID} && userdel -r "$(getent passwd ${UID} | cut -d: -f1)" || true) \
    && useradd -m -s /bin/bash -u ${UID} agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 440 /etc/sudoers.d/agent \
    && mkdir -p /swarm/me /swarm/shared /opt/agent-network && chown -R agent:agent /swarm /opt/agent-network

USER agent
# the harness, built in place
COPY --chown=agent:agent . /opt/agent-network
WORKDIR /opt/agent-network
RUN npm ci --no-audit --no-fund && npm run build \
    && node -e 'import("@xmtp/node-sdk").then(()=>console.log("xmtp native binding ok (" + process.arch + ")"))' \
    && rm -rf /home/agent/.npm

# OptMem (memo); each agent's memories live in /swarm/me/memory via MEMORY_DIR
RUN curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh && test -x /home/agent/.optmem/memo

ENV PATH=/usr/local/cuda/bin:/home/agent/.local/bin:$PATH \
    HF_HOME=/swarm/shared/hf \
    AGENT_MEMO=/home/agent/.optmem/memo \
    MEMORY_DIR=/swarm/me/memory \
    CCACHE_DIR=/swarm/me/.ccache
WORKDIR /swarm/me
CMD ["sleep", "infinity"]
