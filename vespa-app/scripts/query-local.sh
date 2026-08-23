#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 <recall|recall-lexical|recall-semantic|documents> <query> [scope-id] [namespace-id]" >&2
    exit 64
}

[[ $# -ge 2 && $# -le 4 ]] || usage

profile="$1"
query="$2"
scope_id="${3:-capability:payments}"
namespace_id="${4:-acme}"
endpoint="${VESPA_ENDPOINT:-http://127.0.0.1:8080}"

case "$profile" in
    recall|recall-lexical|recall-semantic|documents) ;;
    *) usage ;;
esac

curl --fail --silent --show-error --get "$endpoint/search/" \
    --data-urlencode "queryProfile=$profile" \
    --data-urlencode "query=$query" \
    --data-urlencode "namespace_id=$namespace_id" \
    --data-urlencode "scope_id=$scope_id" \
    --data-urlencode "input.query(query_embedding)=embed(e5, \"$query\")"
