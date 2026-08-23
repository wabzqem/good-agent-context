#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures_dir="$script_dir/../tests/fixtures"
endpoint="${VESPA_ENDPOINT:-http://127.0.0.1:8080}"
namespace="gac"

feed() {
    local document_type="$1"
    local document_id="$2"
    local fixture="$3"

    curl --fail --silent --show-error \
        --request POST \
        --header 'Content-Type: application/json' \
        --data-binary "@$fixtures_dir/$fixture" \
        "$endpoint/document/v1/$namespace/$document_type/docid/$document_id" >/dev/null
}

feed memory mem-auth-boundary memory-auth-boundary.json
feed memory mem-payment-idempotency memory-idempotency.json
feed memory mem-retired-direct-vespa memory-superseded.json
feed memory mem-other-tenant memory-other-tenant.json
feed reference_document doc-payment-retries-v3 reference-payment-retries.json
feed reference_document doc-payment-retries-v2 reference-superseded.json

echo "Fed Phase 1 fixtures."
