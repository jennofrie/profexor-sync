import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProfexorError } from "./errors.ts";
import { changedFiles, git } from "./git.ts";
import { runCommand } from "./process.ts";
import type { ProjectSpec, SyncRun } from "./types.ts";

type LogLine = (line: string) => void | Promise<void>;

function baseDockerArgs(project: ProjectSpec, worktree: string): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const limits = project.validator.resources;
  return [
    "run",
    "--rm",
    "--init",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--cpus=${limits.cpus}`,
    `--memory=${limits.memory}`,
    `--pids-limit=${limits.pids}`,
    `--user=${uid}:${gid}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=2g",
    `--mount=type=bind,src=${worktree},dst=/workspace,rw`,
    "--workdir=/workspace",
  ];
}

async function dockerRun(
  project: ProjectSpec,
  run: SyncRun,
  command: string[],
  options: {
    network: boolean;
    environment?: Record<string, string>;
    mounts?: string[];
    onLine: LogLine;
  },
): Promise<void> {
  const containerName = `profsync-${run.id}`;
  const args = [
    ...baseDockerArgs(project, run.worktreePath),
    `--name=${containerName}`,
    `--label=io.profexor-sync.run=${run.id}`,
    `--network=${options.network ? "bridge" : "none"}`,
  ];
  for (const [name, value] of Object.entries(options.environment ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  for (const mount of options.mounts ?? []) {
    args.push("--mount", mount);
  }
  args.push(project.validator.image, ...command);
  try {
    await runCommand("docker", args, {
      cwd: run.worktreePath,
      timeoutSeconds: project.validator.resources.timeoutSeconds,
      onLine: (_stream, line) => {
        void options.onLine(line);
      },
    });
  } catch (error) {
    await runCommand("docker", ["rm", "--force", containerName], {
      cwd: run.worktreePath,
      allowedExitCodes: [0, 1],
      timeoutSeconds: 30,
    });
    throw error;
  }
}

async function crateNamesForChangedFiles(run: SyncRun): Promise<string[]> {
  if (!run.candidateSha) {
    return [];
  }
  const files = await changedFiles(
    run.worktreePath,
    run.destinationBeforeSha,
    run.candidateSha,
  );
  const manifests = new Set<string>();
  for (const file of files) {
    let current = dirname(join(run.worktreePath, file));
    while (current.startsWith(run.worktreePath) && current !== run.worktreePath) {
      const manifest = join(current, "Cargo.toml");
      try {
        await readFile(manifest, "utf8");
        manifests.add(manifest);
        break;
      } catch {
        current = dirname(current);
      }
    }
  }
  const names = new Set<string>();
  for (const manifest of manifests) {
    const content = await readFile(manifest, "utf8");
    const packageSection = content.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
    const name = packageSection?.[1]?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort().slice(0, 12);
}

async function assertImageAvailable(project: ProjectSpec): Promise<void> {
  const result = await runCommand(
    "docker",
    ["image", "inspect", project.validator.image],
    {
      cwd: project.path,
      allowedExitCodes: [0, 1],
      timeoutSeconds: 30,
    },
  );
  if (result.exitCode !== 0) {
    throw new ProfexorError(
      "VALIDATION_FAILED",
      `Validator image is missing: ${project.validator.image}`,
    );
  }
}

export async function validateInDocker(
  project: ProjectSpec,
  run: SyncRun,
  onLine: LogLine,
): Promise<void> {
  await assertImageAvailable(project);
  const cache = project.validator.cacheVolume;

  if (project.validator.kind === "fexor") {
    const mounts = [
      `type=volume,src=${cache},dst=/home/profsync/.bun/install/cache`,
    ];
    await onLine("Hydrating Bun dependencies with lifecycle scripts disabled");
    await dockerRun(
      project,
      run,
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      {
        network: true,
        environment: {
          HOME: "/home/profsync",
          BUN_INSTALL_CACHE_DIR: "/home/profsync/.bun/install/cache",
        },
        mounts,
        onLine,
      },
    );
    for (const command of [
      ["bun", "test"],
      ["bun", "run", "lint:boundaries"],
      ["bun", "run", "build:dev:full"],
    ]) {
      await onLine(`Running offline: ${command.join(" ")}`);
      await dockerRun(project, run, command, {
        network: false,
        environment: {
          HOME: "/home/profsync",
          BUN_INSTALL_CACHE_DIR: "/home/profsync/.bun/install/cache",
        },
        mounts,
        onLine,
      });
    }
  } else {
    const mounts = [
      `type=volume,src=${cache},dst=/home/profsync/.cargo`,
      `type=volume,src=${cache}-target,dst=/workspace/target`,
    ];
    const environment = {
      HOME: "/home/profsync",
      CARGO_HOME: "/home/profsync/.cargo",
      CARGO_NET_OFFLINE: "true",
      PROTOC: "/usr/bin/protoc",
    };
    await onLine("Hydrating locked Cargo dependencies without compiling project code");
    await dockerRun(project, run, ["cargo", "fetch", "--locked"], {
      network: true,
      environment: {
        ...environment,
        CARGO_NET_OFFLINE: "false",
      },
      mounts,
      onLine,
    });
    const commands: string[][] = [
      ["cargo", "fmt", "--all", "--", "--check"],
      ["cargo", "check", "-p", "xai-grok-pager-bin"],
    ];
    const packages = await crateNamesForChangedFiles(run);
    for (const packageName of packages) {
      commands.push(["cargo", "test", "-p", packageName]);
      commands.push(["cargo", "clippy", "-p", packageName, "--all-targets"]);
    }
    const rootFiles = await changedFiles(
      run.worktreePath,
      run.destinationBeforeSha,
      run.candidateSha ?? "HEAD",
    );
    if (
      rootFiles.some((path) =>
        ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/build/"].some(
          (root) => path === root || path.startsWith(root),
        ),
      )
    ) {
      commands.push(["cargo", "check", "--all-targets", "--workspace"]);
      commands.push(["cargo", "clippy", "--all-targets", "--workspace"]);
    }
    for (const command of commands) {
      await onLine(`Running offline: ${command.join(" ")}`);
      await dockerRun(project, run, command, {
        network: false,
        environment,
        mounts,
        onLine,
      });
    }
  }

  const dirty = await git(run.worktreePath, ["status", "--porcelain=v1"]);
  const trackedChanges = await git(
    run.worktreePath,
    ["diff", "--quiet", "HEAD", "--"],
    { allowedExitCodes: [0, 1] },
  );
  if (trackedChanges.exitCode !== 0) {
    throw new ProfexorError(
      "VALIDATION_FAILED",
      "Validator modified tracked files in the candidate worktree",
      { status: dirty.stdout.slice(0, 4000) },
    );
  }
}
