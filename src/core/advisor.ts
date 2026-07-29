import { z } from "zod";
import { ProfexorError } from "./errors.ts";
import { git } from "./git.ts";
import { runCommand } from "./process.ts";
import type {
  AdvisorRequest,
  AdvisorResponse,
  AppConfig,
  ProjectSpec,
  SyncRun,
} from "./types.ts";

const AdvisorResponseSchema = z.object({
  summary: z.string().max(20_000),
  risks: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high"]),
      message: z.string().max(4_000),
      paths: z.array(z.string().max(2_000)).max(100),
    }),
  ).max(100),
  patches: z.array(
    z.object({
      path: z.string().max(2_000),
      unifiedDiff: z.string().max(500_000),
      rationale: z.string().max(10_000),
      confidence: z.number().min(0).max(1),
    }),
  ).max(100),
});

async function conflictBlob(
  worktreePath: string,
  stage: 1 | 2 | 3,
  path: string,
  maxOutputBytes: number,
): Promise<string> {
  const result = await git(worktreePath, ["show", `:${stage}:${path}`], {
    allowedExitCodes: [0, 128],
    maxOutputBytes,
  });
  return result.exitCode === 0 ? result.stdout : "";
}

export async function buildAdvisorRequest(
  project: ProjectSpec,
  run: SyncRun,
  maxInputBytes = 200_000,
): Promise<AdvisorRequest> {
  const conflicts = [];
  for (const path of run.conflicts) {
    conflicts.push({
      path,
      base: await conflictBlob(run.worktreePath, 1, path, maxInputBytes),
      ours: await conflictBlob(run.worktreePath, 2, path, maxInputBytes),
      theirs: await conflictBlob(run.worktreePath, 3, path, maxInputBytes),
    });
  }
  return {
    schemaVersion: 1,
    task: run.conflicts.length > 0 ? "resolve-conflicts" : "summarize",
    project: {
      id: project.id,
      label: project.label,
    },
    runId: run.id,
    refs: {
      local: run.localSha,
      destination: run.destinationBeforeSha,
      source: run.sourceSha,
      candidate: run.candidateSha,
    },
    commits: run.commits,
    risks: run.risks,
    conflicts,
  };
}

export async function invokeAdvisor(
  config: AppConfig,
  project: ProjectSpec,
  run: SyncRun,
): Promise<AdvisorResponse> {
  const advisor = config.advisor;
  if (!advisor.enabled || advisor.command.length === 0) {
    throw new ProfexorError(
      "ADVISOR_INVALID",
      "Advisor is disabled or no command is configured",
    );
  }
  const request = await buildAdvisorRequest(project, run, advisor.maxInputBytes);
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > advisor.maxInputBytes) {
    throw new ProfexorError("ADVISOR_INVALID", "Advisor request exceeds the configured limit", {
      bytes: Buffer.byteLength(serialized),
      maxInputBytes: advisor.maxInputBytes,
    });
  }
  const [command, ...args] = advisor.command;
  if (!command) {
    throw new ProfexorError("ADVISOR_INVALID", "Advisor command is empty");
  }
  const safeEnvironment: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "LC_ALL", ...advisor.allowedEnvironment]) {
    const value = process.env[name];
    if (value !== undefined) {
      safeEnvironment[name] = value;
    }
  }
  const result = await runCommand(command, args, {
    cwd: run.worktreePath,
    stdin: serialized,
    timeoutSeconds: advisor.timeoutSeconds,
    maxOutputBytes: advisor.maxInputBytes * 3,
    inheritEnv: false,
    env: safeEnvironment,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ProfexorError("ADVISOR_INVALID", "Advisor returned invalid JSON", {}, error);
  }
  const validated = AdvisorResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ProfexorError("ADVISOR_INVALID", "Advisor response failed schema validation", {
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const allowedPaths = new Set(run.conflicts);
  for (const patch of validated.data.patches) {
    if (
      patch.path.startsWith("/") ||
      patch.path.includes("\0") ||
      patch.path.split("/").includes("..") ||
      !allowedPaths.has(patch.path)
    ) {
      throw new ProfexorError("SECURITY_POLICY", "Advisor proposed a patch outside conflict scope", {
        path: patch.path,
      });
    }
  }
  return validated.data;
}

export async function applyAdvisorPatch(
  run: SyncRun,
  response: AdvisorResponse,
  patchIndex: number,
): Promise<void> {
  const patch = response.patches[patchIndex];
  if (!patch) {
    throw new ProfexorError("ADVISOR_INVALID", `Unknown Advisor patch index: ${patchIndex}`);
  }
  if (!run.conflicts.includes(patch.path)) {
    throw new ProfexorError("SECURITY_POLICY", "Patch path is not an active conflict", {
      path: patch.path,
    });
  }
  validatePatchScope(patch.unifiedDiff, patch.path);
  await git(run.worktreePath, ["apply", "--check", "--recount", "-"], {
    stdin: patch.unifiedDiff,
  });
  await git(run.worktreePath, ["apply", "--recount", "-"], {
    stdin: patch.unifiedDiff,
  });
}

function normalizePatchPath(input: string): string | null {
  const raw = input.trim().split(/\s+/)[0] ?? "";
  if (raw === "/dev/null") {
    return null;
  }
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function validatePatchScope(unifiedDiff: string, expectedPath: string): void {
  if (
    /\n(?:GIT binary patch|Binary files |rename from |rename to |copy from |copy to |new file mode |deleted file mode |old mode |new mode )/m.test(
      `\n${unifiedDiff}`,
    )
  ) {
    throw new ProfexorError(
      "SECURITY_POLICY",
      "Advisor patches cannot change file identity, mode, or binary content",
    );
  }
  const paths = new Set<string>();
  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match || match[1] !== expectedPath || match[2] !== expectedPath) {
        throw new ProfexorError(
          "SECURITY_POLICY",
          "Advisor patch header targets an unexpected path",
        );
      }
      paths.add(match[1]);
      paths.add(match[2]);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const normalized = normalizePatchPath(line.slice(4));
      if (normalized !== null) {
        paths.add(normalized);
      }
    }
  }
  if (paths.size === 0 || [...paths].some((path) => path !== expectedPath)) {
    throw new ProfexorError(
      "SECURITY_POLICY",
      "Advisor patch modifies paths outside the active conflict",
      { expectedPath, paths: [...paths] },
    );
  }
}
