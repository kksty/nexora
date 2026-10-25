#
# One Task = one container. The image carries the thin runtime, the DeepSeek
# Harness, and a bash-first tool environment. Executor sessions are processes
# inside this container and are persisted under the mounted task directory.

# Docker CLI for the containerized Web UI. The Web UI container talks to the
# mounted /var/run/docker.sock and starts one sibling container per task, so it
# needs the (statically linked) docker client. Override DOCKER_CLI_IMAGE when
# Docker Hub is unreachable, for example
# docker.m.daocloud.io/library/docker:27-cli.
ARG DOCKER_CLI_IMAGE=docker:27-cli
FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM node:24-bookworm-slim AS deps

# Debian package mirror. Accepts a host name or an http base URL, for example
# mirrors.tuna.tsinghua.edu.cn, http://mirrors.aliyun.com or
# http://deb.debian.org. A trailing /debian or /debian-security is normalized
# away. The default is Tsinghua because it is fast from mainland China;
# pass --build-arg APT_MIRROR=deb.debian.org from another network.
#
# Use http (the default) for the first apt run: bookworm-slim does not ship
# ca-certificates, so an https source would fail before it can be installed.
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn

# Some harness dependencies (for example node-pty) may need to build a native
# addon when a prebuilt binary does not match the Node ABI.
#
# bookworm-slim ships Deb822 sources in /etc/apt/sources.list.d/debian.sources.
# Rewrite the sources explicitly instead of sed-replacing the host: this works
# with either the Deb822 or the classic layout and cannot leave a stale,
# slow source behind.
RUN set -eu; \
    test -n "${APT_MIRROR}"; \
    APT_BASE="${APT_MIRROR%/}"; \
    APT_BASE="${APT_BASE%/debian-security}"; \
    APT_BASE="${APT_BASE%/debian}"; \
    case "${APT_BASE}" in \
      http://*|https://*) ;; \
      *) APT_BASE="http://${APT_BASE}" ;; \
    esac; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/debian.list; \
    printf '%s\n' \
      "deb ${APT_BASE}/debian/ bookworm main contrib non-free non-free-firmware" \
      "deb ${APT_BASE}/debian/ bookworm-updates main contrib non-free non-free-firmware" \
      "deb ${APT_BASE}/debian-security/ bookworm-security main contrib non-free non-free-firmware" \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 update; \
    apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 install -y --no-install-recommends python3 make g++; \
    rm -rf /var/lib/apt/lists/*

# Override when the default npm registry is unreachable or slow.
ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="${NPM_REGISTRY}"

FROM node:24-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn

# A deliberately small, CLI-first toolbox. Agents can install more at runtime,
# but the task directory (not the container filesystem) is the durable layer.
#
# The sources are written from scratch for the same reason as the deps stage:
# do not depend on the base image's Deb822 file or on a host-name substitution.
RUN set -eu; \
    test -n "${APT_MIRROR}"; \
    APT_BASE="${APT_MIRROR%/}"; \
    APT_BASE="${APT_BASE%/debian-security}"; \
    APT_BASE="${APT_BASE%/debian}"; \
    case "${APT_BASE}" in \
      http://*|https://*) ;; \
      *) APT_BASE="http://${APT_BASE}" ;; \
    esac; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/debian.list; \
    printf '%s\n' \
      "deb ${APT_BASE}/debian/ bookworm main contrib non-free non-free-firmware" \
      "deb ${APT_BASE}/debian/ bookworm-updates main contrib non-free non-free-firmware" \
      "deb ${APT_BASE}/debian-security/ bookworm-security main contrib non-free non-free-firmware" \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 update; \
    apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 install -y --no-install-recommends \
      bash ca-certificates coreutils curl wget git jq ripgrep file less \
      procps psmisc iproute2 iputils-ping dnsutils whois traceroute \
      netcat-openbsd nmap masscan tcpdump openssl unzip xz-utils \
      sqlmap ffuf medusa john smbclient dirb nbtscan \
      python3 python3-pip python3-venv tini; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    LIEBIAN_TASKS_DIR=/tasks \
    DSH_HOME=/dsh-home \
    DSH_PERMISSION_MODE=danger-full-access \
    LIEBIAN_PROVIDER=deepseek-official \
    LIEBIAN_MODEL=deepseek-flash \
    LIEBIAN_MODEL_CONCURRENCY=4

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY docker ./docker
COPY compose.yaml ./compose.yaml
COPY compose ./compose

# Containerized Web UI: the docker CLI and compose plugin start one sibling
# Task service per task through the mounted /var/run/docker.sock.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

RUN chmod +x /app/bin/liebian.js /app/bin/liebian-mcp.js /app/docker/entrypoint.sh \
 && printf '%s\n' '#!/usr/bin/env bash' 'exec node /app/bin/liebian.js "$@"' > /usr/local/bin/liebian \
 && printf '%s\n' '#!/usr/bin/env bash' 'exec node /app/bin/liebian-mcp.js "$@"' > /usr/local/bin/liebian-mcp \
 && chmod +x /usr/local/bin/liebian /usr/local/bin/liebian-mcp \
 && mkdir -p /tasks /dsh-home

LABEL org.opencontainers.image.title="liebian" \
      org.opencontainers.image.description="Fission executor runtime: one task per container, many independent sessions inside."

# Executors need UID 0 inside the container: nmap/masscan/tcpdump and raw
# socket work expect it. The container boundary, not a non-root user, is the
# security boundary. Do not override with --user.
USER root

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["run"]
