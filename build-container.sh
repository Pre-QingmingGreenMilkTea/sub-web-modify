#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-sub-web-modify:socks5-tls-fix}"

cd "$PROJECT_DIR"

echo "Building image: $IMAGE_NAME"
docker build --pull=false -t "$IMAGE_NAME" .
echo "Image built successfully: $IMAGE_NAME"
