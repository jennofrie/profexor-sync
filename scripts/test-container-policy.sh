#!/usr/bin/env bash
set -euo pipefail

image="profexor-sync/bun-validator:1.3.14"
docker image inspect "$image" >/dev/null

output="$(
  docker run --rm \
    --network=none \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=64 \
    --memory=512m \
    --cpus=1 \
    --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m \
    "$image" \
    bun -e '
      const homeVisible = await Bun.file("/home/myserver/.config/gh/hosts.yml").exists();
      let networkBlocked = false;
      try {
        await fetch("https://example.com", { signal: AbortSignal.timeout(1500) });
      } catch {
        networkBlocked = true;
      }
      console.log(JSON.stringify({ homeVisible, networkBlocked }));
    '
)"

if [[ "$output" != '{"homeVisible":false,"networkBlocked":true}' ]]; then
  printf 'Container isolation probe failed: %s\n' "$output" >&2
  exit 1
fi

printf 'Container isolation probe passed.\n'
