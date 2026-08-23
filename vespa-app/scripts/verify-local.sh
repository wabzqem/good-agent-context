#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_hit() {
    local response="$1"
    local expected_id="$2"
    local label="$3"

    if ! jq --exit-status --arg expected "$expected_id" \
        '[.root.children[]?.fields | (.memory_id // .document_id)] | index($expected) != null' \
        <<<"$response" >/dev/null; then
        echo "$label: expected $expected_id in result set" >&2
        echo "$response" | jq . >&2
        exit 1
    fi
}

require_no_hit() {
    local response="$1"
    local unexpected_id="$2"
    local label="$3"

    if jq --exit-status --arg unexpected "$unexpected_id" \
        '[.root.children[]?.fields | (.memory_id // .document_id)] | index($unexpected) != null' \
        <<<"$response" >/dev/null; then
        echo "$label: did not expect $unexpected_id in result set" >&2
        echo "$response" | jq . >&2
        exit 1
    fi
}

"$script_dir/feed-fixtures.sh"

memory_response="$("$script_dir/query-local.sh" recall 'where is agent request authentication enforced')"
require_hit "$memory_response" mem-auth-boundary "memory hybrid recall"
require_hit "$memory_response" mem-retired-direct-vespa "superseded memory historical context"
require_no_hit "$memory_response" mem-other-tenant "namespace filter"

if ! jq --exit-status \
    '.root.children[]?.fields | select(.memory_id == "mem-auth-boundary") | (.last_useful_at == 1770000000 and .matchfeatures.lexical != null and .matchfeatures.semantic != null and .matchfeatures.freshness != null and .matchfeatures.utility != null and .matchfeatures.lifecycle_weight == 1)' \
    <<<"$memory_response" >/dev/null; then
    echo "memory hybrid diagnostics are incomplete" >&2
    echo "$memory_response" | jq . >&2
    exit 1
fi

if ! jq --exit-status '
    ([.root.children[] | select(.fields.memory_id == "mem-auth-boundary")][0].relevance) as $active |
    ([.root.children[] | select(.fields.memory_id == "mem-retired-direct-vespa")][0]) as $superseded |
    ($superseded.fields.status == "superseded" and
     $superseded.fields.superseded_by == "mem-auth-boundary" and
     $superseded.fields.matchfeatures.lifecycle_weight == 0.03 and
     $superseded.relevance < ($active * 0.05))
' <<<"$memory_response" >/dev/null; then
    echo "superseded memory was not heavily down-ranked and clearly labelled" >&2
    echo "$memory_response" | jq . >&2
    exit 1
fi

lexical_response="$("$script_dir/query-local.sh" recall-lexical 'tenant isolation gateway credentials')"
require_hit "$lexical_response" mem-auth-boundary "memory lexical recall"

semantic_response="$("$script_dir/query-local.sh" recall-semantic 'which layer stops coding agents from talking to the search store')"
require_hit "$semantic_response" mem-auth-boundary "memory semantic recall"

document_response="$("$script_dir/query-local.sh" documents 'how should a charge retry use an idempotency key')"
require_hit "$document_response" doc-payment-retries-v3 "reference-document hybrid search"
require_no_hit "$document_response" doc-payment-retries-v2 "superseded document filter"

if ! jq --exit-status \
    '.root.children[]?.fields | select(.document_id == "doc-payment-retries-v3") | (.source_path == "specs/payments/retries.md" and .source_revision == "example-commit" and (.chunks | length) > 0)' \
    <<<"$document_response" >/dev/null; then
    echo "reference-document summary did not include provenance and excerpts" >&2
    echo "$document_response" | jq . >&2
    exit 1
fi

echo "Phase 1 verification passed."
