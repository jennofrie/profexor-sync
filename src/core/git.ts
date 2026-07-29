import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfexorError } from "./errors.ts";
import { runCommand, type RunCommandOptions } from "./process.ts";
import type { CommitSummary, ProjectSpec } from "./types.ts";

export type GitRunOptions = Omit<RunCommandOptions, "cwd">;

export async function git(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
) {
  return runCommand(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd, ...options },
  );
}

export async function assertRepository(project: ProjectSpec): Promise<void> {
  try {
    await access(project.path);
  } catch {
    throw new ProfexorError("PROJECT_INVALID", `Project path does not exist: ${project.path}`, {
      projectId: project.id,
      path: project.path,
    });
  }
  const result = await git(project.path, ["rev-parse", "--show-toplevel"]);
  if (result.stdout.trim() !== project.path) {
    throw new ProfexorError(
      "PROJECT_INVALID",
      `Configured project path is not the repository root: ${project.path}`,
      { actual: result.stdout.trim() },
    );
  }
  for (const branch of [
    project.localBranch,
    project.source.branch,
    project.destination.branch,
  ]) {
    const check = await git(
      project.path,
      ["check-ref-format", "--branch", branch],
      { allowedExitCodes: [0, 1, 128] },
    );
    if (check.exitCode !== 0) {
      throw new ProfexorError("PROJECT_INVALID", `Invalid configured branch: ${branch}`);
    }
  }
}

export async function getRemoteUrl(cwd: string, remote: string): Promise<string> {
  return (await git(cwd, ["remote", "get-url", remote])).stdout.trim();
}

export async function getRemotePushUrl(cwd: string, remote: string): Promise<string> {
  return (await git(cwd, ["remote", "get-url", "--push", remote])).stdout.trim();
}

export async function lsRemote(
  cwd: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const result = await git(
    cwd,
    ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`],
    { allowedExitCodes: [0, 2] },
  );
  if (result.exitCode === 2 || result.stdout.trim() === "") {
    return null;
  }
  return result.stdout.trim().split(/\s+/)[0] ?? null;
}

export async function fetchRef(
  cwd: string,
  remote: string,
  branch: string,
  onLine?: GitRunOptions["onLine"],
): Promise<string> {
  await git(
    cwd,
    ["fetch", "--prune", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { timeoutSeconds: 600, onLine },
  );
  return revParse(cwd, `refs/remotes/${remote}/${branch}`);
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

export async function tryRevParse(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], {
    allowedExitCodes: [0, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["branch", "--show-current"])).stdout.trim();
}

export async function dirtyPaths(cwd: string): Promise<string[]> {
  const output = (await git(cwd, ["status", "--porcelain=v1", "-z"])).stdout;
  if (!output) {
    return [];
  }
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

export async function hasInProgressOperation(cwd: string): Promise<boolean> {
  const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const candidates = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
  for (const candidate of candidates) {
    try {
      await access(join(gitDir, candidate));
      return true;
    } catch {
      // Continue checking.
    }
  }
  return false;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

export async function hasCommonAncestor(cwd: string, left: string, right: string): Promise<boolean> {
  const result = await git(cwd, ["merge-base", left, right], { allowedExitCodes: [0, 1] });
  return result.exitCode === 0 && result.stdout.trim() !== "";
}

export async function listCommits(
  cwd: string,
  base: string,
  head: string,
): Promise<CommitSummary[]> {
  const separator = "\u001f";
  const record = "\u001e";
  const output = (
    await git(cwd, [
      "log",
      "--reverse",
      `--format=%H${separator}%h${separator}%an${separator}%aI${separator}%s${record}`,
      `${base}..${head}`,
    ])
  ).stdout;
  return output
    .split(record)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, shortSha, author, authoredAt, subject] = entry.split(separator);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        author: author ?? "",
        authoredAt: authoredAt ?? "",
        subject: subject ?? "",
      };
    });
}

export async function changedFiles(
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> {
  const output = (await git(cwd, ["diff", "--name-only", "-z", `${base}..${head}`])).stdout;
  return output.split("\0").filter(Boolean);
}

export async function addWorktree(
  cwd: string,
  worktreePath: string,
  branchName: string,
  startSha: string,
): Promise<void> {
  await git(cwd, ["worktree", "add", "--no-track", "-b", branchName, worktreePath, startSha], {
    timeoutSeconds: 120,
  });
}

export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  await git(cwd, ["worktree", "remove", "--force", worktreePath], {
    timeoutSeconds: 120,
  });
}

export async function deleteBranch(cwd: string, branchName: string): Promise<void> {
  await git(cwd, ["branch", "-D", branchName]);
}

export async function conflictPaths(cwd: string): Promise<string[]> {
  const output = (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout;
  return output.split("\0").filter(Boolean);
}

export async function mergeMessage(cwd: string): Promise<string | null> {
  const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  try {
    return await readFile(join(gitDir, "MERGE_MSG"), "utf8");
  } catch {
    return null;
  }
}

export function githubSlug(remoteUrl: string): string | null {
  const normalized = remoteUrl.replace(/\.git$/, "");
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (https?.[1]) {
    return https[1];
  }
  const ssh = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  return ssh?.[1] ?? null;
}
