export const RunStatus = {
  Preparing: "preparing",
  Conflicts: "conflicts",
  Ready: "ready",
  Validating: "validating",
  ValidationFailed: "validation_failed",
  Validated: "validated",
  Promoted: "promoted",
  PullRequest: "pull_request",
  Failed: "failed",
  Discarded: "discarded",
  Stale: "stale",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const EventLevel = {
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
} as const;

export type EventLevel = (typeof EventLevel)[keyof typeof EventLevel];

export type RemoteRef = {
  remote: string;
  branch: string;
};

export type ResourceLimits = {
  cpus: number;
  memory: string;
  pids: number;
  timeoutSeconds: number;
};

export type DockerValidatorSpec = {
  kind: "fexor" | "grok";
  image: string;
  cacheVolume: string;
  resources: ResourceLimits;
};

export type ProjectSpec = {
  id: string;
  label: string;
  path: string;
  localBranch: string;
  source: RemoteRef;
  destination: RemoteRef;
  validator: DockerValidatorSpec;
};

export type IdentitySpec = {
  name: string;
  email: string;
  githubLogin: string;
};

export type AdvisorSpec = {
  enabled: boolean;
  command: string[];
  timeoutSeconds: number;
  maxInputBytes: number;
  allowedEnvironment: string[];
};

export type AppConfig = {
  schemaVersion: 1;
  identity: IdentitySpec;
  monitor: {
    intervalMinutes: number;
  };
  advisor: AdvisorSpec;
  projects: ProjectSpec[];
};

export type RiskItem = {
  level: "low" | "medium" | "high";
  category: string;
  message: string;
  paths: string[];
};

export type CommitSummary = {
  sha: string;
  shortSha: string;
  author: string;
  authoredAt: string;
  subject: string;
};

export type MergeHead = {
  sha: string;
  label: string;
};

export type ProjectObservation = {
  projectId: string;
  checkedAt: string;
  sourceSha: string | null;
  destinationSha: string | null;
  unread: boolean;
  error: string | null;
};

export type SyncRun = {
  id: string;
  projectId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  localSha: string;
  destinationBeforeSha: string;
  sourceSha: string;
  candidateSha: string | null;
  branchName: string;
  worktreePath: string;
  pendingHeads: MergeHead[];
  currentMergeLabel: string | null;
  conflicts: string[];
  commits: CommitSummary[];
  risks: RiskItem[];
  validatedCandidateSha: string | null;
  validatorImage: string | null;
  promotedAt: string | null;
  pullRequestUrl: string | null;
  error: string | null;
  advisorResponse: AdvisorResponse | null;
};

export type AuditEvent = {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  level: EventLevel;
  projectId: string | null;
  runId: string | null;
  action: string;
  message: string;
  details: Record<string, unknown>;
};

export type AdvisorRequest = {
  schemaVersion: 1;
  task: "summarize" | "resolve-conflicts";
  project: {
    id: string;
    label: string;
  };
  runId: string;
  refs: {
    local: string;
    destination: string;
    source: string;
    candidate: string | null;
  };
  commits: CommitSummary[];
  risks: RiskItem[];
  conflicts: Array<{
    path: string;
    base: string;
    ours: string;
    theirs: string;
  }>;
};

export type AdvisorResponse = {
  summary: string;
  risks: Array<{
    severity: "low" | "medium" | "high";
    message: string;
    paths: string[];
  }>;
  patches: Array<{
    path: string;
    unifiedDiff: string;
    rationale: string;
    confidence: number;
  }>;
};

export type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
};
