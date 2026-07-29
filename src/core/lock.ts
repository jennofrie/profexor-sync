import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfexorError } from "./errors.ts";

type LockOwner = {
  pid: number;
  createdAt: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireProjectLock(
  locksDir: string,
  projectId: string,
): Promise<() => Promise<void>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new ProfexorError("SECURITY_POLICY", "Invalid lock identifier");
  }
  const lockDir = join(locksDir, `${projectId}.lock`);
  const ownerFile = join(lockDir, "owner.json");

  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch {
    let owner: LockOwner | null = null;
    try {
      owner = JSON.parse(await readFile(ownerFile, "utf8")) as LockOwner;
    } catch {
      owner = null;
    }
    if (owner && isProcessAlive(owner.pid)) {
      throw new ProfexorError("LOCKED", `${projectId} is already being processed`, {
        pid: owner.pid,
        createdAt: owner.createdAt,
      });
    }
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir, { mode: 0o700 });
  }

  await writeFile(
    ownerFile,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await rm(lockDir, { recursive: true, force: true });
  };
}
