import { access, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { invokeAdvisor, applyAdvisorPatch as applyAdvisorPatchFile } from "./advisor.ts";
import { validateInDocker } from "./docker.ts";
import { errorMessage, ProfexorError } from "./errors.ts";
import {
  addWorktree,
  assertRepository,
  changedFiles,
  conflictPaths,
  currentBranch,
  deleteBranch,
  dirtyPaths,
  fetchRef,
  getRemoteUrl,
  git,
  githubSlug,
  hasCommonAncestor,
  hasInProgressOperation,
  isAncestor,
  listCommits,
  lsRemote,
  removeWorktree,
  revParse,
  tryRevParse,
} from "./git.ts";
import { acquireProjectLock } from "./lock.ts";
import { runCommand } from "./process.ts";
import { scoreRisk } from "./risk.ts";
import type { AppPaths } from "./paths.ts";
import type { StateStore } from "./state.ts";
import {
  EventLevel,
  RunStatus,
  type AppConfig,
  type CommitSummary,
  type DoctorCheck,
  type MergeHead,
  type ProjectObservation,
  type ProjectSpec,
  type SyncRun,
} from "./types.ts";
import { findProject } from "./config.ts";

type EngineOptions = {
  config: AppConfig;
  paths: AppPaths;
  state: StateStore;
  onActivity?: (line: string) => void;
};

function now(): string {
  return new Date().toISOString();
}

function shortSha(sha: string | null): string {
  return sha?.slice(0, 12) ?? "missing";
}

function mergeIdentityArgs(config: AppConfig): string[] {
  return [
    "-c",
    `user.name=${config.identity.name}`,
    "-c",
    `user.email=${config.identity.email}`,
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=false",
    "-c",
    "merge.conflictStyle=zdiff3",
  ];
}

function uniqueHeads(heads: MergeHead[]): MergeHead[] {
  const seen = new Set<string>();
  return heads.filter((head) => {
    if (seen.has(head.sha)) {
      return false;
    }
    seen.add(head.sha);
    return true;
  });
}

async function commandExists(command: string): Promise<boolean> {
  if (command === "bun" && process.versions.bun) {
    return true;
  }
  return Bun.which(command) !== null;
}

export class SyncEngine {
  readonly config: AppConfig;
  readonly paths: AppPaths;
  readonly state: StateStore;
  readonly onActivity?: (line: string) => void;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.paths = options.paths;
    this.state = options.state;
    this.onActivity = options.onActivity;
  }

  project(id: string): ProjectSpec {
    return findProject(this.config, id);
  }

  private activity(projectId: string, message: string): void {
    const line = `${new Date().toLocaleString()} | ${projectId} | ${message}`;
    this.onActivity?.(line);
  }

  private async runLog(runId: string, line: string): Promise<void> {
    const sanitized = line.replace(/\r/g, "");
    await this.state.appendRunLog(runId, `${now()} ${sanitized}`);
    this.onActivity?.(sanitized);
  }

  async checkProject(projectId: string): Promise<ProjectObservation> {
    const project = this.project(projectId);
    const checkedAt = now();
    try {
      await assertRepository(project);
      const sourceSha = await lsRemote(
        project.path,
        project.source.remote,
        project.source.branch,
      );
      const destinationSha =
        project.source.remote === project.destination.remote &&
        project.source.branch === project.destination.branch
          ? sourceSha
          : await lsRemote(
              project.path,
              project.destination.remote,
              project.destination.branch,
            );
      const previous = this.state.getObservation(project.id);
      const observation: ProjectObservation = {
        projectId: project.id,
        checkedAt,
        sourceSha,
        destinationSha,
        unread:
          previous?.sourceSha !== null &&
          previous?.sourceSha !== undefined &&
          sourceSha !== null &&
          previous.sourceSha !== sourceSha,
        error: null,
      };
      this.state.recordObservation(observation);
      await this.state.event(
        "remote.check",
        `${project.label}: source ${shortSha(sourceSha)}, destination ${shortSha(destinationSha)}`,
        {
          projectId: project.id,
          details: { sourceSha, destinationSha, changed: observation.unread },
        },
      );
      this.activity(project.id, observation.unread ? "NEW REMOTE COMMITS" : "up to date");
      return this.state.getObservation(project.id) ?? observation;
    } catch (error) {
      const observation: ProjectObservation = {
        projectId: project.id,
        checkedAt,
        sourceSha: null,
        destinationSha: null,
        unread: false,
        error: errorMessage(error),
      };
      this.state.recordObservation(observation);
      await this.state.event("remote.check_failed", errorMessage(error), {
        level: EventLevel.Error,
        projectId: project.id,
      });
      return observation;
    }
  }

  async checkAll(): Promise<ProjectObservation[]> {
    const observations: ProjectObservation[] = [];
    for (const project of this.config.projects) {
      observations.push(await this.checkProject(project.id));
    }
    return observations;
  }

  async prepare(projectId: string): Promise<SyncRun | null> {
    const project = this.project(projectId);
    const release = await acquireProjectLock(this.paths.locksDir, project.id);
    try {
      await assertRepository(project);
      if (await hasInProgressOperation(project.path)) {
        throw new ProfexorError(
          "PROJECT_INVALID",
          `${project.label} has an incomplete Git operation`,
        );
      }
      const configuredBranchSha = await revParse(project.path, project.localBranch);
      const previousDestinationSha = await tryRevParse(
        project.path,
        `refs/remotes/${project.destination.remote}/${project.destination.branch}`,
      );
      const destinationSha = await fetchRef(
        project.path,
        project.destination.remote,
        project.destination.branch,
        (_stream, line) => this.activity(project.id, line),
      );
      if (
        previousDestinationSha &&
        !(await isAncestor(project.path, previousDestinationSha, destinationSha))
      ) {
        throw new ProfexorError(
          "STALE_RUN",
          `${project.destination.remote}/${project.destination.branch} was rewritten`,
          {
            previous: previousDestinationSha,
            current: destinationSha,
          },
        );
      }
      const previousSourceSha =
        project.source.remote === project.destination.remote &&
        project.source.branch === project.destination.branch
          ? previousDestinationSha
          : await tryRevParse(
              project.path,
              `refs/remotes/${project.source.remote}/${project.source.branch}`,
            );
      const sourceSha =
        project.source.remote === project.destination.remote &&
        project.source.branch === project.destination.branch
          ? destinationSha
          : await fetchRef(
              project.path,
              project.source.remote,
              project.source.branch,
              (_stream, line) => this.activity(project.id, line),
            );
      if (
        previousSourceSha &&
        !(await isAncestor(project.path, previousSourceSha, sourceSha))
      ) {
        throw new ProfexorError(
          "STALE_RUN",
          `${project.source.remote}/${project.source.branch} was rewritten`,
          {
            previous: previousSourceSha,
            current: sourceSha,
          },
        );
      }

      const heads = uniqueHeads([
        {
          sha: destinationSha,
          label: `${project.destination.remote}/${project.destination.branch}`,
        },
        {
          sha: sourceSha,
          label: `${project.source.remote}/${project.source.branch}`,
        },
      ]);
      const pendingHeads: MergeHead[] = [];
      for (const head of heads) {
        if (!(await isAncestor(project.path, head.sha, configuredBranchSha))) {
          pendingHeads.push(head);
        }
      }
      if (pendingHeads.length === 0) {
        await this.state.event("sync.no_changes", `${project.label} has no incoming commits`, {
          projectId: project.id,
          details: { localSha: configuredBranchSha, destinationSha, sourceSha },
        });
        this.state.markProjectRead(project.id);
        return null;
      }

      const id = crypto.randomUUID();
      const branchName = `profsync/${project.id}/${id.slice(0, 12)}`;
      const worktreePath = join(this.paths.worktreesDir, project.id, id);
      await mkdir(join(this.paths.worktreesDir, project.id), {
        recursive: true,
        mode: 0o700,
      });

      const commitsBySha = new Map<string, CommitSummary>();
      for (const head of pendingHeads) {
        const baseResult = await git(project.path, ["merge-base", configuredBranchSha, head.sha]);
        for (const commit of await listCommits(project.path, baseResult.stdout.trim(), head.sha)) {
          commitsBySha.set(commit.sha, commit);
        }
      }
      const run: SyncRun = {
        id,
        projectId: project.id,
        status: RunStatus.Preparing,
        createdAt: now(),
        updatedAt: now(),
        localSha: configuredBranchSha,
        destinationBeforeSha: destinationSha,
        sourceSha,
        candidateSha: null,
        branchName,
        worktreePath,
        pendingHeads,
        currentMergeLabel: null,
        conflicts: [],
        commits: [...commitsBySha.values()].sort((left, right) =>
          left.authoredAt.localeCompare(right.authoredAt),
        ),
        risks: [],
        validatedCandidateSha: null,
        validatorImage: null,
        promotedAt: null,
        pullRequestUrl: null,
        error: null,
        advisorResponse: null,
      };
      this.state.saveRun(run);
      await this.state.event(
        "sync.prepare",
        `${project.label}: preparing ${run.commits.length} incoming commits`,
        {
          projectId: project.id,
          runId: run.id,
          details: {
            localSha: run.localSha,
            destinationSha,
            sourceSha,
            worktreePath,
          },
        },
      );
      await addWorktree(project.path, worktreePath, branchName, configuredBranchSha);
      try {
        await this.advanceRun(project, run);
      } catch (error) {
        run.status = RunStatus.Failed;
        run.error = errorMessage(error);
        run.updatedAt = now();
        this.state.saveRun(run);
        throw error;
      }
      this.state.markProjectRead(project.id);
      return run;
    } catch (error) {
      await this.state.event("sync.prepare_failed", errorMessage(error), {
        level: EventLevel.Error,
        projectId,
      });
      throw error;
    } finally {
      await release();
    }
  }

  private async advanceRun(project: ProjectSpec, run: SyncRun): Promise<void> {
    while (run.pendingHeads.length > 0) {
      const head = run.pendingHeads.shift();
      if (!head) {
        break;
      }
      const current = await revParse(run.worktreePath, "HEAD");
      if (await isAncestor(run.worktreePath, head.sha, current)) {
        continue;
      }
      if (!(await hasCommonAncestor(run.worktreePath, current, head.sha))) {
        run.status = RunStatus.Failed;
        run.error = `No common ancestor with ${head.label}`;
        run.updatedAt = now();
        this.state.saveRun(run);
        throw new ProfexorError(
          "RUN_INVALID",
          `No common history with ${head.label}`,
          { head: head.sha },
        );
      }
      if (await isAncestor(run.worktreePath, current, head.sha)) {
        await git(run.worktreePath, ["merge", "--ff-only", head.sha]);
        continue;
      }
      const message = [
        `chore(sync): merge ${head.label} into ${project.id}`,
        "",
        `Profexor-Sync-Run: ${run.id}`,
        `Source-Ref: ${head.label}`,
        `Source-Commit: ${head.sha}`,
        `Destination-Before: ${run.destinationBeforeSha}`,
      ].join("\n");
      const result = await git(
        run.worktreePath,
        [
          ...mergeIdentityArgs(this.config),
          "merge",
          "--no-ff",
          "-m",
          message,
          head.sha,
        ],
        {
          allowedExitCodes: [0, 1],
          onLine: (_stream, line) => {
            void this.runLog(run.id, line);
          },
        },
      );
      if (result.exitCode === 1) {
        const conflicts = await conflictPaths(run.worktreePath);
        if (conflicts.length === 0) {
          throw new ProfexorError("COMMAND_FAILED", `Merge of ${head.label} failed`, {
            stderr: result.stderr.slice(-4000),
          });
        }
        run.status = RunStatus.Conflicts;
        run.currentMergeLabel = head.label;
        run.conflicts = conflicts;
        run.candidateSha = await revParse(run.worktreePath, "HEAD");
        run.updatedAt = now();
        this.state.saveRun(run);
        await this.state.event(
          "sync.conflicts",
          `${project.label}: ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`,
          {
            level: EventLevel.Warn,
            projectId: project.id,
            runId: run.id,
            details: { conflicts, head: head.label },
          },
        );
        return;
      }
    }

    run.candidateSha = await revParse(run.worktreePath, "HEAD");
    const files = await changedFiles(run.worktreePath, run.localSha, run.candidateSha);
    run.risks = scoreRisk(files, run.commits);
    run.status = RunStatus.Ready;
    run.currentMergeLabel = null;
    run.conflicts = [];
    run.updatedAt = now();
    this.state.saveRun(run);
    await this.state.event(
      "sync.ready",
      `${project.label}: candidate ${shortSha(run.candidateSha)} is ready for validation`,
      {
        projectId: project.id,
        runId: run.id,
        details: {
          candidateSha: run.candidateSha,
          commits: run.commits.length,
          files: files.length,
          risks: run.risks,
        },
      },
    );
  }

  async continueAfterConflicts(runId: string, useMergiraf = false): Promise<SyncRun> {
    const run = this.requireRun(runId);
    const project = this.project(run.projectId);
    const release = await acquireProjectLock(this.paths.locksDir, project.id);
    try {
      if (run.status !== RunStatus.Conflicts) {
        throw new ProfexorError("RUN_INVALID", "Run is not waiting on conflicts");
      }
      if (useMergiraf) {
        if (!(await commandExists("mergiraf"))) {
          throw new ProfexorError("RUN_INVALID", "Mergiraf is not installed");
        }
        for (const path of run.conflicts) {
          await runCommand("mergiraf", ["solve", path], {
            cwd: run.worktreePath,
            allowedExitCodes: [0, 1],
            timeoutSeconds: 120,
          });
        }
      }
      const markerCheck = await git(
        run.worktreePath,
        [
          "grep",
          "-n",
          "-E",
          "^(<<<<<<<|=======|>>>>>>>)",
          "--",
          ...run.conflicts,
        ],
        { allowedExitCodes: [0, 1] },
      );
      if (markerCheck.exitCode === 0) {
        throw new ProfexorError(
          "RUN_INVALID",
          "Conflict markers remain; review the worktree before continuing",
          { paths: run.conflicts },
        );
      }
      await git(run.worktreePath, ["add", "--", ...run.conflicts]);
      const unresolved = await conflictPaths(run.worktreePath);
      if (unresolved.length > 0) {
        run.conflicts = unresolved;
        run.updatedAt = now();
        this.state.saveRun(run);
        throw new ProfexorError("RUN_INVALID", "Conflicts remain unresolved", {
          conflicts: unresolved,
        });
      }
      await git(
        run.worktreePath,
        [...mergeIdentityArgs(this.config), "commit", "--no-edit"],
      );
      run.status = RunStatus.Preparing;
      run.currentMergeLabel = null;
      run.conflicts = [];
      run.updatedAt = now();
      this.state.saveRun(run);
      await this.advanceRun(project, run);
      return run;
    } finally {
      await release();
    }
  }

  async validate(runId: string): Promise<SyncRun> {
    const run = this.requireRun(runId);
    const project = this.project(run.projectId);
    const release = await acquireProjectLock(this.paths.locksDir, project.id);
    try {
      if (
        run.status !== RunStatus.Ready &&
        run.status !== RunStatus.ValidationFailed
      ) {
        throw new ProfexorError("RUN_INVALID", `Run cannot be validated from ${run.status}`);
      }
      const candidateSha = await revParse(run.worktreePath, "HEAD");
      run.status = RunStatus.Validating;
      run.candidateSha = candidateSha;
      run.error = null;
      run.updatedAt = now();
      this.state.saveRun(run);
      await this.state.event("validation.started", `${project.label}: validation started`, {
        projectId: project.id,
        runId: run.id,
        details: { candidateSha, image: project.validator.image },
      });

      try {
        await validateInDocker(project, run, async (line) => {
          await this.runLog(run.id, line);
        });
        const afterSha = await revParse(run.worktreePath, "HEAD");
        if (afterSha !== candidateSha) {
          throw new ProfexorError(
            "VALIDATION_FAILED",
            "Candidate SHA changed while validation was running",
          );
        }
        run.status = RunStatus.Validated;
        run.validatedCandidateSha = candidateSha;
        run.validatorImage = project.validator.image;
        run.updatedAt = now();
        this.state.saveRun(run);
        await this.state.event(
          "validation.passed",
          `${project.label}: all validation gates passed`,
          {
            projectId: project.id,
            runId: run.id,
            details: { candidateSha, image: project.validator.image },
          },
        );
        return run;
      } catch (error) {
        run.status = RunStatus.ValidationFailed;
        run.error = errorMessage(error);
        run.updatedAt = now();
        this.state.saveRun(run);
        await this.state.event("validation.failed", errorMessage(error), {
          level: EventLevel.Error,
          projectId: project.id,
          runId: run.id,
        });
        throw error;
      }
    } finally {
      await release();
    }
  }

  async advise(runId: string): Promise<SyncRun> {
    const run = this.requireRun(runId);
    const project = this.project(run.projectId);
    const response = await invokeAdvisor(this.config, project, run);
    run.advisorResponse = response;
    run.updatedAt = now();
    this.state.saveRun(run);
    await this.state.event("advisor.completed", `${project.label}: Advisor response recorded`, {
      projectId: project.id,
      runId: run.id,
      details: {
        risks: response.risks.length,
        patches: response.patches.length,
      },
    });
    return run;
  }

  async applyAdvisorPatch(runId: string, patchIndex: number): Promise<SyncRun> {
    const run = this.requireRun(runId);
    if (!run.advisorResponse) {
      throw new ProfexorError("ADVISOR_INVALID", "No Advisor response is recorded");
    }
    await applyAdvisorPatchFile(run, run.advisorResponse, patchIndex);
    await this.state.event("advisor.patch_applied", `Advisor patch ${patchIndex} applied for review`, {
      projectId: run.projectId,
      runId: run.id,
      details: { patchIndex, path: run.advisorResponse.patches[patchIndex]?.path },
    });
    return run;
  }

  async promote(runId: string): Promise<SyncRun> {
    const run = this.requireRun(runId);
    const project = this.project(run.projectId);
    const release = await acquireProjectLock(this.paths.locksDir, project.id);
    try {
      if (run.status !== RunStatus.Validated) {
        throw new ProfexorError("RUN_INVALID", "Only a validated run can be promoted");
      }
      if (!run.candidateSha || run.validatedCandidateSha !== run.candidateSha) {
        throw new ProfexorError("STALE_RUN", "Validation does not match the candidate SHA");
      }
      if ((await currentBranch(project.path)) !== project.localBranch) {
        throw new ProfexorError(
          "PROMOTION_REJECTED",
          `Primary worktree must be on ${project.localBranch}`,
        );
      }
      const dirty = await dirtyPaths(project.path);
      if (dirty.length > 0) {
        throw new ProfexorError(
          "DIRTY_WORKTREE",
          `${project.label} has ${dirty.length} uncommitted path${dirty.length === 1 ? "" : "s"}`,
          { count: dirty.length },
        );
      }
      if (await hasInProgressOperation(project.path)) {
        throw new ProfexorError("PROMOTION_REJECTED", "Primary worktree has an incomplete Git operation");
      }
      const remoteDestination = await lsRemote(
        project.path,
        project.destination.remote,
        project.destination.branch,
      );
      const remoteSource =
        project.source.remote === project.destination.remote &&
        project.source.branch === project.destination.branch
          ? remoteDestination
          : await lsRemote(project.path, project.source.remote, project.source.branch);
      if (
        remoteDestination !== run.destinationBeforeSha ||
        remoteSource !== run.sourceSha
      ) {
        run.status = RunStatus.Stale;
        run.error = "Remote refs changed after candidate preparation";
        run.updatedAt = now();
        this.state.saveRun(run);
        throw new ProfexorError("STALE_RUN", run.error, {
          expectedDestination: run.destinationBeforeSha,
          actualDestination: remoteDestination,
          expectedSource: run.sourceSha,
          actualSource: remoteSource,
        });
      }
      if (
        !(await isAncestor(
          run.worktreePath,
          run.destinationBeforeSha,
          run.candidateSha,
        ))
      ) {
        throw new ProfexorError(
          "PROMOTION_REJECTED",
          "Candidate is not a fast-forward of destination main",
        );
      }
      const remoteUrl = await getRemoteUrl(project.path, project.destination.remote);
      const slug = githubSlug(remoteUrl);
      if (!slug || slug.split("/")[0]?.toLowerCase() !== this.config.identity.githubLogin.toLowerCase()) {
        throw new ProfexorError(
          "PROMOTION_REJECTED",
          "Destination remote is not owned by the configured GitHub account",
          { destination: slug ?? "non-GitHub remote" },
        );
      }
      const protectedBranch = slug
        ? await this.isProtectedBranch(slug, project.destination.branch)
        : false;

      if (protectedBranch) {
        await git(run.worktreePath, [
          "push",
          project.destination.remote,
          `${run.candidateSha}:refs/heads/${run.branchName}`,
        ]);
        const pr = await runCommand(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            slug,
            "--head",
            run.branchName,
            "--base",
            project.destination.branch,
            "--title",
            `chore(sync): update ${project.id}`,
            "--body",
            `Prepared by Profexor Sync.\n\nRun: ${run.id}\nCandidate: ${run.candidateSha}`,
          ],
          { cwd: run.worktreePath, timeoutSeconds: 120 },
        );
        run.status = RunStatus.PullRequest;
        run.pullRequestUrl = pr.stdout.trim();
        run.updatedAt = now();
        this.state.saveRun(run);
        await this.state.event(
          "promotion.pull_request",
          `${project.label}: pull request created`,
          {
            projectId: project.id,
            runId: run.id,
            details: { url: run.pullRequestUrl, candidateSha: run.candidateSha },
          },
        );
        return run;
      }

      await git(run.worktreePath, [
        "push",
        project.destination.remote,
        `${run.candidateSha}:refs/heads/${project.destination.branch}`,
      ]);
      run.status = RunStatus.Promoted;
      run.promotedAt = now();
      run.updatedAt = now();
      this.state.saveRun(run);
      await this.state.event(
        "promotion.pushed",
        `${project.label}: ${shortSha(run.candidateSha)} pushed to ${slug ?? project.destination.remote}:${project.destination.branch}`,
        {
          projectId: project.id,
          runId: run.id,
          details: {
            candidateSha: run.candidateSha,
            target: `${slug ?? project.destination.remote}:${project.destination.branch}`,
          },
        },
      );

      let localUpdated = false;
      try {
        if ((await dirtyPaths(project.path)).length === 0) {
          await git(project.path, ["merge", "--ff-only", run.candidateSha]);
          localUpdated = true;
        }
      } catch (error) {
        await this.state.event(
          "promotion.local_update_warning",
          `${project.label}: remote main advanced but local main was left unchanged`,
          {
            level: EventLevel.Warn,
            projectId: project.id,
            runId: run.id,
            details: { error: errorMessage(error) },
          },
        );
      }
      if (localUpdated) {
        await this.cleanupCandidate(project, run);
      }
      return run;
    } finally {
      await release();
    }
  }

  async discard(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const project = this.project(run.projectId);
    const release = await acquireProjectLock(this.paths.locksDir, project.id);
    try {
      if (
        run.status === RunStatus.Promoted ||
        run.status === RunStatus.PullRequest
      ) {
        throw new ProfexorError("RUN_INVALID", "Published runs cannot be discarded");
      }
      await this.cleanupCandidate(project, run);
      run.status = RunStatus.Discarded;
      run.updatedAt = now();
      this.state.saveRun(run);
      await this.state.event("sync.discarded", `${project.label}: candidate discarded`, {
        projectId: project.id,
        runId: run.id,
      });
    } finally {
      await release();
    }
  }

  private async cleanupCandidate(project: ProjectSpec, run: SyncRun): Promise<void> {
    try {
      await access(run.worktreePath);
      await removeWorktree(project.path, run.worktreePath);
    } catch {
      // Worktree is already absent.
    }
    const branchResult = await git(project.path, ["show-ref", "--verify", `refs/heads/${run.branchName}`], {
      allowedExitCodes: [0, 1],
    });
    if (branchResult.exitCode === 0) {
      await deleteBranch(project.path, run.branchName);
    }
  }

  private async isProtectedBranch(slug: string, branch: string): Promise<boolean> {
    const result = await runCommand(
      "gh",
      ["api", `repos/${slug}/branches/${branch}/protection`],
      {
        cwd: this.paths.stateDir,
        allowedExitCodes: [0, 1],
        timeoutSeconds: 30,
      },
    );
    return result.exitCode === 0;
  }

  requireRun(id: string): SyncRun {
    const run = this.state.getRun(id);
    if (!run) {
      throw new ProfexorError("RUN_INVALID", `Unknown run: ${id}`, { id });
    }
    return run;
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const command of ["git", "gh", "docker", "bun", "systemctl"]) {
      checks.push({
        name: command,
        status: (await commandExists(command)) ? "pass" : "fail",
        message: (await commandExists(command)) ? "available" : "not found",
      });
    }
    checks.push({
      name: "mergiraf",
      status: (await commandExists("mergiraf")) ? "pass" : "warn",
      message: (await commandExists("mergiraf"))
        ? "available"
        : "not installed; syntax-aware conflict solving is unavailable",
    });
    const gh = await runCommand("gh", ["api", "user", "--jq", ".login"], {
      cwd: this.paths.stateDir,
      allowedExitCodes: [0, 1],
      timeoutSeconds: 30,
    });
    checks.push({
      name: "GitHub identity",
      status: gh.exitCode === 0 && gh.stdout.trim() === this.config.identity.githubLogin ? "pass" : "fail",
      message:
        gh.exitCode === 0
          ? `active account: ${gh.stdout.trim()}`
          : "GitHub authentication unavailable",
    });
    const docker = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], {
      cwd: this.paths.stateDir,
      allowedExitCodes: [0, 1],
      timeoutSeconds: 30,
    });
    checks.push({
      name: "Docker daemon",
      status: docker.exitCode === 0 ? "pass" : "fail",
      message: docker.exitCode === 0 ? `server ${docker.stdout.trim()}` : "unavailable",
    });
    if (docker.exitCode === 0) {
      const orphaned = await runCommand(
        "docker",
        [
          "ps",
          "--all",
          "--filter",
          "label=io.profexor-sync.run",
          "--format",
          "{{.Names}}",
        ],
        {
          cwd: this.paths.stateDir,
          allowedExitCodes: [0, 1],
          timeoutSeconds: 30,
        },
      );
      const names = orphaned.stdout.split(/\r?\n/).filter(Boolean);
      checks.push({
        name: "Validator containers",
        status: names.length === 0 ? "pass" : "warn",
        message:
          names.length === 0
            ? "no orphaned containers"
            : `${names.length} orphaned validator container${names.length === 1 ? "" : "s"}`,
      });
    }
    for (const project of this.config.projects) {
      try {
        await assertRepository(project);
        const sourceUrl = await getRemoteUrl(project.path, project.source.remote);
        const destinationUrl = await getRemoteUrl(project.path, project.destination.remote);
        const dirty = await dirtyPaths(project.path);
        checks.push({
          name: project.label,
          status: dirty.length > 0 ? "warn" : "pass",
          message: `${sourceUrl} → ${destinationUrl}; ${dirty.length} dirty path${dirty.length === 1 ? "" : "s"}`,
        });
      } catch (error) {
        checks.push({
          name: project.label,
          status: "fail",
          message: errorMessage(error),
        });
      }
      const image = await runCommand("docker", ["image", "inspect", project.validator.image], {
        cwd: this.paths.stateDir,
        allowedExitCodes: [0, 1],
        timeoutSeconds: 30,
      });
      checks.push({
        name: `${project.label} validator`,
        status: image.exitCode === 0 ? "pass" : "warn",
        message:
          image.exitCode === 0
            ? project.validator.image
            : `${project.validator.image} has not been built`,
      });
    }
    return checks;
  }
}
