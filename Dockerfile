# contract-ops-agent — the zero-setup path. Everything bundled: the agent, the
# full contract-ops CLI suite, and a PDF backend. Bring only a model key.
#
#   docker run -it --rm \
#     -v "$PWD:/workspace" \                    # your contracts
#     -v contract-ops-config:/config \          # persists config + stored keys
#     -e OPENAI_API_KEY \                       # or GEMINI_API_KEY / ANTHROPIC_API_KEY / …
#     ghcr.io/drbaher/contract-ops-agent
#
# Subcommands work the same way: `… contract-ops-agent doctor`, `… tool lint_contract '{…}'`.
FROM node:22-slim

LABEL org.opencontainers.image.source="https://github.com/DrBaher/contract-ops-agent" \
      org.opencontainers.image.description="Contract work in an enclosure — the agent, the full contract-ops CLI suite, and a PDF backend, bundled. Bring only a model key." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="contract-ops-agent"

# Python CLIs (pipx-isolated), and LibreOffice headless as the convert_to_pdf
# backend. One layer, caches purged.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 pipx ca-certificates \
       libreoffice-writer \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin
# (Debian's pipx predates multi-package install — one call per package.)
RUN set -e; for p in extract-cli template-vault-cli nda-review-cli contract-lint contract-vault; do pipx install "$p"; done

# The agent (pulls contract-ops-mcp with it) + the suite's npm CLIs.
# sign-cli is the HUMAN's signing tool — the agent's enclosure can't reach it.
ARG AGENT_VERSION=latest
RUN npm install -g --omit=dev \
      contract-ops-agent@${AGENT_VERSION} \
      @drbaher/draft-cli compare-cli docx2pdf-cli @drbaher/sign-cli \
  && npm cache clean --force

# Non-root: contracts and config are volume-mounted, nothing to own beyond them.
RUN useradd -m -u 1001 agent \
  && mkdir -p /workspace /config \
  && chown agent:agent /workspace /config
USER agent

# Config (and 0600-stored keys) live on the /config volume so setup survives
# container recreation.
ENV XDG_CONFIG_HOME=/config
WORKDIR /workspace
VOLUME ["/workspace", "/config"]

ENTRYPOINT ["contract-ops-agent"]
