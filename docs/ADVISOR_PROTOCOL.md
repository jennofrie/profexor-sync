# Advisor command protocol

The Advisor is optional and disabled by default. Profexor Sync does not embed a
model SDK or provider name.

Configure an executable as an argument array:

```yaml
advisor:
  enabled: true
  command: ["/absolute/path/to/advisor-wrapper", "review"]
  timeoutSeconds: 120
  maxInputBytes: 200000
  allowedEnvironment: []
```

The command receives one versioned JSON request on standard input and must emit
one JSON response on standard output. The schemas live in `schemas/`.

Only tracked commit metadata and conflicted Git blobs are included. Untracked
files, environment values, GitHub credentials, and repository-wide source are
never supplied. The child environment contains only `PATH`, locale variables,
and explicitly allowlisted names.

Suggested patches must target an active conflicted path. Profexor Sync validates
the response, previews it, checks it with `git apply --check`, and requires an
interactive acceptance before changing the candidate. Advisor output never
promotes, pushes, or rewrites history.
