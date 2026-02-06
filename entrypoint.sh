#!/bin/sh
# Get container name from Docker API using this container's ID (hostname)
# The Docker API returns Name with a leading / like "/reconmc-agent-1"
RESULT=$(curl -s --unix-socket /var/run/docker.sock "http://v1.41/containers/$(hostname)/json" 2>/dev/null) || RESULT=''

# Extract Name field value - look for "Name": "/something" pattern
CONTAINER_NAME=$(echo "$RESULT" | grep -oE '"Name":\s*"/[^"]*"' | head -1 | sed 's/"Name":\s*"\/\(.*\)"/\1/')

# Fallback to hostname if Docker API fails
if [ -z "$CONTAINER_NAME" ]; then
  CONTAINER_NAME=$(hostname)
fi

# Extract agent ID by stripping "reconmc-" prefix
AGENT_ID=$(echo "$CONTAINER_NAME" | sed 's/^reconmc-//')

# Final fallback
if [ -z "$AGENT_ID" ]; then
  AGENT_ID="agent-unknown"
fi

export AGENT_ID
exec "$@"
