#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$script_dir/.." && pwd)"
container_name="${VESPA_CONTAINER_NAME:-good-agent-context-vespa}"
container_app_dir="/tmp/good-agent-context-vespa-app"
local_package_dir="$(mktemp -d)"

cleanup() {
    rm -rf "$local_package_dir"
}
trap cleanup EXIT

if ! docker ps --format '{{.Names}}' | grep -Fxq "$container_name"; then
    echo "Container $container_name is not running. Run scripts/start-local.sh first." >&2
    exit 1
fi

cp -R "$app_dir/." "$local_package_dir"
cp "$app_dir/services.local.xml" "$local_package_dir/services.xml"
docker exec "$container_name" mkdir -p "$container_app_dir"
docker cp "$local_package_dir/." "$container_name:$container_app_dir"
docker exec "$container_name" /opt/vespa/bin/vespa-deploy prepare "$container_app_dir"
docker exec "$container_name" /opt/vespa/bin/vespa-deploy activate

for attempt in $(seq 1 120); do
    if curl --fail --silent --show-error http://127.0.0.1:8080/ApplicationStatus >/dev/null; then
        echo "Application deployed."
        exit 0
    fi
    sleep 1
done

echo "Application did not become ready within 120 seconds." >&2
exit 1
