#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$script_dir/start-local.sh"
"$script_dir/deploy-local.sh"
"$script_dir/verify-local.sh"
