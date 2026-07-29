#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  printf 'Run this installer as the desktop user, not root.\n' >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

bun install --frozen-lockfile
bun run ./src/cli.tsx init

if ! command -v mergiraf >/dev/null 2>&1; then
  cargo install --locked mergiraf
fi

"$project_root/scripts/bootstrap-projects.sh"
"$project_root/scripts/build-validator-images.sh"
bun run ./src/cli.tsx service install
bun run ./src/cli.tsx check --all
bun run ./src/cli.tsx doctor
