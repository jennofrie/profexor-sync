# Profexor Sync

Profexor Sync is a review-first GitHub update synchronizer for repositories that
carry local maintenance changes. It detects upstream movement, prepares the
complete incoming commit range in an isolated worktree, shows commits and diffs
in a terminal UI, validates the candidate in locked-down Docker containers, and
promotes only after explicit human confirmation.

Maintained by **Profexor**.

## Why it exists

Ordinary `git pull` is adequate for clean clones. Maintained variants need more:
they can be locally ahead, remotely behind, dirty, or divergent at the same
time. Profexor Sync makes those states visible and keeps the irreversible
boundary—updating GitHub `main`—human-controlled.

The TUI is a control panel. The Git engine is headless and testable, so the
15-minute monitor works without an open terminal.

## Safety model

```text
remote check
  -> review whole incoming range
  -> isolated candidate worktree
  -> Git/rerere/Mergiraf conflict handling
  -> offline Docker validation
  -> exact-SHA stale check
  -> typed confirmation
  -> fast-forward push to main
```

- No force-pushes, reset-based synchronization, published rebases, or guessed
  cherry-pick subsets.
- A dirty primary worktree can be monitored and reviewed but cannot be promoted.
- Upstream commit authors and legal notices remain intact.
- Divergent integrations create a merge commit as
  `Profexor <58376175+jennofrie@users.noreply.github.com>`.
- No model/provider attribution, generated-by marker, or model co-author trailer
  is added.
- Background checks never execute fetched code.
- Validators receive no host home directory, API keys, GitHub credentials,
  network during tests, elevated capability, or Docker socket.

See [SECURITY.md](SECURITY.md) and the
[Advisor protocol](docs/ADVISOR_PROTOCOL.md).

## Ubuntu installation

Requirements are Bun 1.3.14+, Git, GitHub CLI authentication, Docker, Rust/Cargo,
and user-level systemd.

```bash
cd /home/myserver/Desktop/Profexor-Sync
./scripts/install-ubuntu.sh
```

The installer:

1. validates the active GitHub account;
2. creates/clones `jennofrie/grok-build` and configures read-only `upstream`;
3. retains the existing Fexor worktree untouched;
4. installs Mergiraf and validator images;
5. creates `~/.local/bin/profsync`;
6. enables a persistent 15-minute user-systemd timer.

No target `main` branch is changed during installation.

## Commands

```text
profsync                              Open the TUI
profsync check --all [--json]         Check public remote refs only
profsync prepare PROJECT_ID           Fetch and prepare an isolated candidate
profsync continue RUN_ID --mergiraf   Continue a reviewed conflict resolution
profsync validate RUN_ID              Run sandboxed validation
profsync advise RUN_ID                Request optional provider-neutral advice
profsync apply-advice RUN_ID INDEX    Interactively apply one scoped patch
profsync promote RUN_ID               Typed confirmation, then fast-forward main
profsync discard RUN_ID               Remove an unpublished candidate
profsync history [PROJECT_ID]         Show durable runs
profsync doctor                       Verify tooling, remotes, state, and images
profsync service install|status|uninstall
```

Inside the TUI:

```text
↑/↓ project   Tab view   r check   p prepare   v validate
c Mergiraf/continue   a Advisor   m promote   d discard   q quit
```

## State and audit

Runtime configuration and state never live in a managed repository:

```text
~/.config/profexor-sync/config.yaml
~/.local/state/profexor-sync/profexor-sync.sqlite
~/.local/state/profexor-sync/events.jsonl
~/.local/state/profexor-sync/runs/
~/.local/state/profexor-sync/worktrees/
~/.cache/profexor-sync/
```

SQLite backs the TUI and run state. `events.jsonl` is an append-only audit
stream. Full sanitized validator output is retained per run.

## Development

```bash
bun install
bun run typecheck
bun test
```

Integration tests use temporary local bare repositories and cannot touch a real
GitHub project. OpenTUI is consumed as a published dependency; no source is
copied from the server's separate OpenTUI checkout.

## License

MIT © 2026 Profexor.
