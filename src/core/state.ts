import { Database } from "bun:sqlite";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";
import { redactValue } from "./redaction.ts";
import type {
  AdvisorResponse,
  AuditEvent,
  CommitSummary,
  MergeHead,
  ProjectObservation,
  RiskItem,
  RunStatus,
  SyncRun,
} from "./types.ts";
import { EventLevel } from "./types.ts";
import type { AppPaths } from "./paths.ts";

type RunRow = {
  id: string;
  project_id: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  local_sha: string;
  destination_before_sha: string;
  source_sha: string;
  candidate_sha: string | null;
  branch_name: string;
  worktree_path: string;
  pending_heads_json: string;
  current_merge_label: string | null;
  conflicts_json: string;
  commits_json: string;
  risks_json: string;
  validated_candidate_sha: string | null;
  validator_image: string | null;
  promoted_at: string | null;
  pull_request_url: string | null;
  error: string | null;
  advisor_response_json: string | null;
};

type ObservationRow = {
  project_id: string;
  checked_at: string;
  source_sha: string | null;
  destination_sha: string | null;
  unread: number;
  error: string | null;
};

function parseJson<T>(input: string | null, fallback: T): T {
  if (!input) {
    return fallback;
  }
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: RunRow): SyncRun {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    localSha: row.local_sha,
    destinationBeforeSha: row.destination_before_sha,
    sourceSha: row.source_sha,
    candidateSha: row.candidate_sha,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    pendingHeads: parseJson<MergeHead[]>(row.pending_heads_json, []),
    currentMergeLabel: row.current_merge_label,
    conflicts: parseJson<string[]>(row.conflicts_json, []),
    commits: parseJson<CommitSummary[]>(row.commits_json, []),
    risks: parseJson<RiskItem[]>(row.risks_json, []),
    validatedCandidateSha: row.validated_candidate_sha,
    validatorImage: row.validator_image,
    promotedAt: row.promoted_at,
    pullRequestUrl: row.pull_request_url,
    error: row.error,
    advisorResponse: parseJson<AdvisorResponse | null>(row.advisor_response_json, null),
  };
}

export class StateStore {
  readonly database: Database;
  readonly paths: AppPaths;
  readonly logger: Logger;

  private constructor(paths: AppPaths, database: Database, logger: Logger) {
    this.paths = paths;
    this.database = database;
    this.logger = logger;
  }

  static async open(paths: AppPaths): Promise<StateStore> {
    await Promise.all([
      mkdir(dirname(paths.databaseFile), { recursive: true, mode: 0o700 }),
      mkdir(paths.runsDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.worktreesDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.locksDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.cacheDir, { recursive: true, mode: 0o700 }),
    ]);
    const database = new Database(paths.databaseFile, { create: true });
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        project_id TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        source_sha TEXT,
        destination_sha TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        local_sha TEXT NOT NULL,
        destination_before_sha TEXT NOT NULL,
        source_sha TEXT NOT NULL,
        candidate_sha TEXT,
        branch_name TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        pending_heads_json TEXT NOT NULL DEFAULT '[]',
        current_merge_label TEXT,
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        commits_json TEXT NOT NULL DEFAULT '[]',
        risks_json TEXT NOT NULL DEFAULT '[]',
        validated_candidate_sha TEXT,
        validator_image TEXT,
        promoted_at TEXT,
        pull_request_url TEXT,
        error TEXT,
        advisor_response_json TEXT
      );

      CREATE INDEX IF NOT EXISTS runs_project_created
        ON runs(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        project_id TEXT,
        run_id TEXT,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_timestamp
        ON events(timestamp DESC);
    `);
    const logger = pino(
      {
        base: undefined,
        timestamp: false,
      },
      pino.destination({ dest: paths.auditFile, mkdir: true, sync: true }),
    );
    await Promise.all([
      chmod(paths.databaseFile, 0o600),
      chmod(paths.auditFile, 0o600),
    ]);
    return new StateStore(paths, database, logger);
  }

  close(): void {
    this.logger.flush();
    this.database.close();
  }

  recordObservation(observation: ProjectObservation): void {
    const current = this.getObservation(observation.projectId);
    const unread =
      observation.error === null &&
      current?.sourceSha !== null &&
      current?.sourceSha !== undefined &&
      observation.sourceSha !== current.sourceSha
        ? true
        : observation.unread || current?.unread || false;
    this.database
      .query(`
        INSERT INTO observations (
          project_id, checked_at, source_sha, destination_sha, unread, error
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          checked_at = excluded.checked_at,
          source_sha = excluded.source_sha,
          destination_sha = excluded.destination_sha,
          unread = excluded.unread,
          error = excluded.error
      `)
      .run(
        observation.projectId,
        observation.checkedAt,
        observation.sourceSha,
        observation.destinationSha,
        unread ? 1 : 0,
        observation.error,
      );
  }

  getObservation(projectId: string): ProjectObservation | null {
    const row = this.database
      .query<ObservationRow, [string]>("SELECT * FROM observations WHERE project_id = ?")
      .get(projectId);
    if (!row) {
      return null;
    }
    return {
      projectId: row.project_id,
      checkedAt: row.checked_at,
      sourceSha: row.source_sha,
      destinationSha: row.destination_sha,
      unread: row.unread === 1,
      error: row.error,
    };
  }

  listObservations(): ProjectObservation[] {
    return this.database
      .query<ObservationRow, []>("SELECT * FROM observations ORDER BY project_id")
      .all()
      .map((row) => ({
        projectId: row.project_id,
        checkedAt: row.checked_at,
        sourceSha: row.source_sha,
        destinationSha: row.destination_sha,
        unread: row.unread === 1,
        error: row.error,
      }));
  }

  markProjectRead(projectId: string): void {
    this.database.query("UPDATE observations SET unread = 0 WHERE project_id = ?").run(projectId);
  }

  saveRun(run: SyncRun): void {
    this.database
      .query(`
        INSERT INTO runs (
          id, project_id, status, created_at, updated_at, local_sha,
          destination_before_sha, source_sha, candidate_sha, branch_name,
          worktree_path, pending_heads_json, current_merge_label,
          conflicts_json, commits_json, risks_json, validated_candidate_sha,
          validator_image, promoted_at, pull_request_url, error,
          advisor_response_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          candidate_sha = excluded.candidate_sha,
          pending_heads_json = excluded.pending_heads_json,
          current_merge_label = excluded.current_merge_label,
          conflicts_json = excluded.conflicts_json,
          commits_json = excluded.commits_json,
          risks_json = excluded.risks_json,
          validated_candidate_sha = excluded.validated_candidate_sha,
          validator_image = excluded.validator_image,
          promoted_at = excluded.promoted_at,
          pull_request_url = excluded.pull_request_url,
          error = excluded.error,
          advisor_response_json = excluded.advisor_response_json
      `)
      .run(
        run.id,
        run.projectId,
        run.status,
        run.createdAt,
        run.updatedAt,
        run.localSha,
        run.destinationBeforeSha,
        run.sourceSha,
        run.candidateSha,
        run.branchName,
        run.worktreePath,
        JSON.stringify(run.pendingHeads),
        run.currentMergeLabel,
        JSON.stringify(run.conflicts),
        JSON.stringify(run.commits),
        JSON.stringify(run.risks),
        run.validatedCandidateSha,
        run.validatorImage,
        run.promotedAt,
        run.pullRequestUrl,
        run.error,
        run.advisorResponse ? JSON.stringify(run.advisorResponse) : null,
      );
  }

  getRun(id: string): SyncRun | null {
    const row = this.database
      .query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?")
      .get(id);
    return row ? mapRun(row) : null;
  }

  listRuns(projectId?: string, limit = 100): SyncRun[] {
    const rows = projectId
      ? this.database
          .query<RunRow, [string, number]>(
            "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(projectId, limit)
      : this.database
          .query<RunRow, [number]>("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return rows.map(mapRun);
  }

  async event(
    action: string,
    message: string,
    options: {
      level?: AuditEvent["level"];
      projectId?: string | null;
      runId?: string | null;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: options.level ?? EventLevel.Info,
      projectId: options.projectId ?? null,
      runId: options.runId ?? null,
      action,
      message,
      details: (redactValue(options.details ?? {}) ?? {}) as Record<string, unknown>,
    };
    this.database
      .query(`
        INSERT INTO events (
          id, timestamp, level, project_id, run_id, action, message, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.timestamp,
        event.level,
        event.projectId,
        event.runId,
        event.action,
        event.message,
        JSON.stringify(event.details),
      );
    this.logger.info(event);
    return event;
  }

  listEvents(limit = 200): AuditEvent[] {
    type EventRow = {
      id: string;
      timestamp: string;
      level: AuditEvent["level"];
      project_id: string | null;
      run_id: string | null;
      action: string;
      message: string;
      details_json: string;
    };
    return this.database
      .query<EventRow, [number]>("SELECT * FROM events ORDER BY timestamp DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        schemaVersion: 1,
        id: row.id,
        timestamp: row.timestamp,
        level: row.level,
        projectId: row.project_id,
        runId: row.run_id,
        action: row.action,
        message: row.message,
        details: parseJson<Record<string, unknown>>(row.details_json, {}),
      }));
  }

  async appendRunLog(runId: string, line: string): Promise<void> {
    const runDir = `${this.paths.runsDir}/${runId}`;
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await appendFile(`${runDir}/commands.log`, `${line}\n`, { mode: 0o600 });
  }
}
