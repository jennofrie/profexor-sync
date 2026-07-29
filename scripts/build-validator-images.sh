#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker build \
  --file "$project_root/containers/bun-validator.Dockerfile" \
  --tag profexor-sync/bun-validator:1.3.14 \
  "$project_root"

docker build \
  --file "$project_root/containers/rust-validator.Dockerfile" \
  --tag profexor-sync/rust-validator:1.92 \
  "$project_root"
