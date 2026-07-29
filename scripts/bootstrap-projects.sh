#!/usr/bin/env bash
set -euo pipefail

github_root="/home/myserver/Desktop/Github"
fexor_path="$github_root/fexor-code"
grok_path="$github_root/grok-build"

if [[ ! -d "$fexor_path/.git" ]]; then
  printf 'Fexor repository is missing: %s\n' "$fexor_path" >&2
  exit 1
fi

active_login="$(gh api user --jq .login)"
if [[ "$active_login" != "jennofrie" ]]; then
  printf 'Expected GitHub account jennofrie, found %s\n' "$active_login" >&2
  exit 1
fi

if ! gh api repos/jennofrie/grok-build >/dev/null 2>&1; then
  gh api --method POST repos/xai-org/grok-build/forks >/dev/null
  for _attempt in {1..30}; do
    if gh api repos/jennofrie/grok-build >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
fi

if ! gh api repos/jennofrie/grok-build >/dev/null 2>&1; then
  printf 'GitHub did not finish creating jennofrie/grok-build\n' >&2
  exit 1
fi

if [[ ! -d "$grok_path/.git" ]]; then
  gh repo clone jennofrie/grok-build "$grok_path"
fi

git -C "$grok_path" remote set-url origin https://github.com/jennofrie/grok-build.git
if git -C "$grok_path" remote get-url upstream >/dev/null 2>&1; then
  git -C "$grok_path" remote set-url upstream https://github.com/xai-org/grok-build.git
else
  git -C "$grok_path" remote add upstream https://github.com/xai-org/grok-build.git
fi
git -C "$grok_path" remote set-url --push upstream DISABLED
git -C "$grok_path" fetch --prune --no-tags origin main
git -C "$grok_path" fetch --prune --no-tags upstream main

printf 'Configured Fexor: %s\n' "$fexor_path"
printf 'Configured Grok Build: %s\n' "$grok_path"
