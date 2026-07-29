# Profexor Sync workspace guide

Profexor Sync is a Bun/TypeScript Git synchronization harness with an OpenTUI
front end.

## Locked safety properties

- Monitoring never changes managed repositories.
- Promotion is interactive, fast-forward-only, and blocked by a dirty primary
  worktree or stale remote ref.
- Never add force-push, automatic conflict acceptance, automatic promotion, or
  credential logging.
- Preserve upstream commit authors and legal notices.
- Integration commits use the configured Profexor identity without model or
  generated-by trailers.
- Incoming build/test code runs only through the Docker validator boundary.

## Checks

```bash
bun run typecheck
bun test
```

Use temporary bare Git repositories for integration tests. Do not use the real
Fexor or Grok repositories as fixtures.
