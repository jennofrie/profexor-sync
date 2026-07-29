# Contributing

Use Conventional Commits, strict TypeScript, and focused changes.

Before proposing a change:

```bash
bun install --frozen-lockfile
bun run check
```

Tests that exercise Git must use temporary local bare repositories. They must
not require GitHub credentials or modify a real repository. Any change to
promotion, validation, redaction, or audit behavior requires both a known-good
and known-bad regression fixture.
