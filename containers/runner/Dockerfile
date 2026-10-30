# Diffinery runner image (Cloudflare Containers, linux/amd64).
# Build context: containers/runner. Run `pnpm build` first so dist/agent.mjs exists.
#
#   docker build --platform linux/amd64 -t diffinery-runner containers/runner
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG NODE_VERSION=22.22.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DIFFINERY_WORK_ROOT=/workspace \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # What hosted ubuntu-24.04 runners report; setup-* actions key their caches on it.
    ImageOS=ubuntu24 \
    ImageVersion=20250101.1 \
    # Ubuntu 24.04 marks the system Python as externally managed (PEP 668);
    # CI scripts commonly `pip install` directly, so allow it like hosted runners do.
    PIP_BREAK_SYSTEM_PACKAGES=1

# The -dev libraries are what ruby/setup-ruby's prebuilt Rubies link against (psych needs
# libyaml) and what gems' native extensions build with, as on hosted runners. Jobs run as root,
# and sudo is there (passwordless, as root) so `sudo apt-get install ...` works as on GitHub.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git git-lfs jq zip unzip xz-utils tar gzip zstd sudo \
      build-essential pkg-config openssh-client gnupg \
      python3 python3-pip python3-venv python-is-python3 \
      libyaml-dev libssl-dev libffi-dev zlib1g-dev libreadline-dev libgmp-dev \
      bubblewrap \
 && git config --system --add safe.directory '*' \
 && git lfs install --system --skip-repo \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Node.js LTS from the official tarball (checksum-verified), with corepack shims for pnpm/yarn.
RUN set -eux; \
    cd /tmp; \
    file="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c -; \
    tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/include/*' --exclude='*/share/doc/*'; \
    rm -f "${file}"; \
    corepack enable; \
    corepack prepare pnpm@10.28.0 --activate; \
    corepack prepare yarn@1.22.22 --activate; \
    node --version; npm --version; pnpm --version; yarn --version; \
    npm cache clean --force; \
    rm -rf /root/.npm /tmp/*

# nvm, as on hosted runners: login shells (`shell: bash -l {0}`) can `nvm install` other Node.js versions.
# A fixed tag, checked against its commit.
ARG NVM_VERSION=v0.40.7
ARG NVM_COMMIT=f0b0c6bb0b281ceeb106c8cf9ab8fde141215092
ENV NVM_DIR=/usr/local/nvm
RUN set -eux; \
    git clone -q --depth 1 --branch "${NVM_VERSION}" https://github.com/nvm-sh/nvm.git "${NVM_DIR}"; \
    test "$(git -C "${NVM_DIR}" rev-parse HEAD)" = "${NVM_COMMIT}"; \
    rm -rf "${NVM_DIR}/.git"; \
    printf '%s\n' 'export NVM_DIR=/usr/local/nvm' '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' > /etc/profile.d/nvm.sh; \
    bash -lc 'nvm --version'

# GitHub CLI (preinstalled on hosted runners; workflows call `gh` with GH_TOKEN).
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# GitHub's own runner, for jobs of GitHub repositories that run on Diffinery runners
# (apps/diffinery/docs/actions/github-runners.md; the agent starts it with a just-in-time
# configuration). A fixed release, checked against its published SHA-256. GitHub updates a runner
# that falls too far behind as it starts, so keep this close to the latest release.
ARG ACTIONS_RUNNER_VERSION=2.338.2
ARG ACTIONS_RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
RUN set -eux;     mkdir -p /opt/actions-runner;     cd /tmp;     file="actions-runner-linux-x64-${ACTIONS_RUNNER_VERSION}.tar.gz";     curl -fsSLo "${file}" "https://github.com/actions/runner/releases/download/v${ACTIONS_RUNNER_VERSION}/${file}";     echo "${ACTIONS_RUNNER_SHA256}  ${file}" | sha256sum -c -;     tar -xzf "${file}" -C /opt/actions-runner --no-same-owner;     rm -f "${file}";     /opt/actions-runner/bin/installdependencies.sh;     apt-get clean;     rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Docker Engine, started on first use by the /usr/local/bin/docker wrapper. Cloudflare
# Containers run it rootful with iptables, so bridge networks, service DNS, port
# publishing and builds all work like on GitHub's hosted runners.
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin iptables; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY image/daemon.json /etc/docker/daemon.json
COPY image/docker /usr/local/bin/docker

RUN mkdir -p /workspace /opt/hostedtoolcache /opt/diffinery
# image-tag (written by scripts/runner-image.sh) names this image in each job's log and API.
COPY dist/agent.mjs dist/image-tag* /opt/diffinery/

WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["node", "/opt/diffinery/agent.mjs"]
