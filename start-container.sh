#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-sub-web-modify:socks5-tls-fix}"
CONTAINER_NAME="${CONTAINER_NAME:-sub-web-modify}"
HOST_PORT="${1:-${HOST_PORT:-8080}}"
SUBCONVERTER_UPSTREAM="${SUBCONVERTER_UPSTREAM:-https://api.v1.mk}"

cd "$PROJECT_DIR"

if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "Image not found: $IMAGE_NAME" >&2
  echo "Run ./build-container.sh first." >&2
  exit 1
fi

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "Replacing existing container: $CONTAINER_NAME"
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$HOST_PORT" | grep -q .; then
  echo "Port $HOST_PORT is already in use. Stop the existing service or set HOST_PORT to another port." >&2
  exit 1
fi

echo "Starting $CONTAINER_NAME on port $HOST_PORT"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart=unless-stopped \
  -p "$HOST_PORT:80" \
  -e "SUBCONVERTER_UPSTREAM=$SUBCONVERTER_UPSTREAM" \
  "$IMAGE_NAME" >/dev/null

for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$HOST_PORT/healthz" >/dev/null 2>&1; then
    echo "Container is healthy: http://127.0.0.1:$HOST_PORT"
    exit 0
  fi

  if ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Container exited before becoming healthy." >&2
    exit 1
  fi

  sleep 1
done

echo "Container did not become healthy in time." >&2
docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
exit 1
