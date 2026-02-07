#!/bin/sh
set -e

RESULT=$(curl -s --unix-socket /var/run/docker.sock "http://v1.41/containers/$(hostname)/json" 2>/dev/null) || RESULT=''

CONTAINER_NAME=$(echo "$RESULT" | grep -oE '"Name":\s*"/[^"]*"' | head -1 | sed 's/"Name":\s*"\/\(.*\)"/\1/')

if [ -z "$CONTAINER_NAME" ]; then
  CONTAINER_NAME=$(hostname)
fi

AGENT_ID=$(echo "$CONTAINER_NAME" | sed 's/^reconmc-//')

if [ -z "$AGENT_ID" ]; then
  AGENT_ID="agent-unknown"
fi

export AGENT_ID

COORDINATOR_URL="${COORDINATOR_URL:-http://coordinator:3000}"
MAX_WAIT=60
WAITED=0

echo "[entrypoint] Agent ID: $AGENT_ID"
echo "[entrypoint] Waiting for coordinator at $COORDINATOR_URL ..."

while [ "$WAITED" -lt "$MAX_WAIT" ]; do
  if curl -sf "${COORDINATOR_URL}/api/health" > /dev/null 2>&1; then
    echo "[entrypoint] Coordinator is ready"
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

if [ "$WAITED" -ge "$MAX_WAIT" ]; then
  echo "[entrypoint] WARNING: Coordinator not reachable after ${MAX_WAIT}s, starting anyway"
fi

exec "$@"
