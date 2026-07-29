import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig, ProjectSpec } from "../src/core/types.ts";
import type { AppPaths } from "../src/core/paths.ts";

export function command(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

export async function temporaryRoot(prefix = "profexor-sync-test-"): Promise<string> {
  return mkdtemp(join(realpathSync(tmpdir()), prefix));
}

export async function removeTemporaryRoot(path: string): Promise<void> {
  if (!path.startsWith(realpathSync(tmpdir()))) {
    throw new Error(`Refusing to remove non-temporary path: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

export function testPaths(root: string): AppPaths {
  const stateDir = join(root, "state");
  return {
    configFile: join(root, "config.yaml"),
    stateDir,
    databaseFile: join(stateDir, "state.sqlite"),
    auditFile: join(stateDir, "events.jsonl"),
    runsDir: join(stateDir, "runs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
    cacheDir: join(root, "cache"),
  };
}

export function projectConfig(project: ProjectSpec): AppConfig {
  return {
    schemaVersion: 1,
    identity: {
      name: "Profexor",
      email: "58376175+jennofrie@users.noreply.github.com",
      githubLogin: "jennofrie",
    },
    monitor: {
      intervalMinutes: 15,
    },
    advisor: {
      enabled: false,
      command: [],
      timeoutSeconds: 10,
      maxInputBytes: 200_000,
      allowedEnvironment: [],
    },
    projects: [project],
  };
}
