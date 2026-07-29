import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type AppPaths = {
  configFile: string;
  stateDir: string;
  databaseFile: string;
  auditFile: string;
  runsDir: string;
  worktreesDir: string;
  locksDir: string;
  cacheDir: string;
};

export function createAppPaths(configOverride?: string): AppPaths {
  const home = homedir();
  const configFile =
    configOverride ??
    process.env.PROFEXOR_SYNC_CONFIG ??
    join(home, ".config", "profexor-sync", "config.yaml");
  const stateDir = join(home, ".local", "state", "profexor-sync");

  return {
    configFile: resolve(configFile),
    stateDir,
    databaseFile: join(stateDir, "profexor-sync.sqlite"),
    auditFile: join(stateDir, "events.jsonl"),
    runsDir: join(stateDir, "runs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
    cacheDir: join(home, ".cache", "profexor-sync"),
  };
}
