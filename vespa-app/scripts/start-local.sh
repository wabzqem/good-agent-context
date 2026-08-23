#!/usr/bin/env bash
set -euo pipefail

container_name="good-agent-context-vespa"
image="vespaengine/vespa:latest"

if docker ps --format '{{.Names}}' | grep -Fxq "$container_name"; then
    echo "Vespa container is already running: $container_name"
elif docker ps -a --format '{{.Names}}' | grep -Fxq "$container_name"; then
    docker start "$container_name" >/dev/null
    echo "Started existing Vespa container: $container_name"
else
    docker run --detach --name "$container_name" --hostname "$container_name" \
        --publish 127.0.0.1:8080:8080 \
        --publish 127.0.0.1:19071:19071 \
        "$image" >/dev/null
    echo "Created Vespa container: $container_name"
fi

for attempt in $(seq 1 120); do
    if curl --fail --silent --show-error http://127.0.0.1:19071/state/v1/health >/dev/null; then
        echo "Vespa config server is healthy."
        exit 0
    fi
    sleep 1
done

echo "Vespa did not become healthy within 120 seconds." >&2
exit 1
