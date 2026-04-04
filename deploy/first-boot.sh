#!/bin/bash
set -e

# Pull the pre-built agent Docker image from GHCR (runs once on first boot).
# NanoClaw uses CONTAINER_IMAGE env var to reference it directly.
if ! docker image inspect ghcr.io/onecli/nanoclaw-agent:latest >/dev/null 2>&1; then
    echo "Pulling agent Docker image..."
    docker pull ghcr.io/onecli/nanoclaw-agent:latest
    echo "Agent image ready."
fi
