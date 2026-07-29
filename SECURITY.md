# Security

Profexor Sync treats fetched source as untrusted until reviewed and validated.

- The background timer only compares public remote refs.
- Candidate work happens in isolated Git worktrees.
- Test and build commands run in Docker without the host home directory,
  credentials, elevated capabilities, Docker socket, or test-time network.
- Promotion requires an interactive confirmation and a clean primary worktree.
- Force-push, reset-based synchronization, and unattended promotion are not
  implemented.
- Logs redact common secret shapes and never intentionally record environment
  values.

Do not store API keys or passwords in the project configuration. A configured
Advisor should obtain its own credentials from an external secret manager.

Report security problems privately to the repository owner rather than opening
a public issue containing exploit details or credentials.
