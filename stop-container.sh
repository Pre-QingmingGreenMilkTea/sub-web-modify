#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-sub-web-modify}"

if ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "Container does not exist: $CONTAINER_NAME"
  exit 0
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" == "true" ]]; then
  docker stop "$CONTAINER_NAME" >/dev/null
  echo "Container stopped: $CONTAINER_NAME"
else
  echo "Container is already stopped: $CONTAINER_NAME"
fi
