import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ProfexorError } from "./errors.ts";
import { runCommand } from "./process.ts";
import type { AppPaths } from "./paths.ts";

function systemdDir(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return join(configHome, "systemd", "user");
}

function unitQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new ProfexorError("SECURITY_POLICY", "Unsafe control character in systemd value");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function unitPath(value: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value)) {
    throw new ProfexorError(
      "SECURITY_POLICY",
      "Systemd paths must be absolute and contain only safe path characters",
    );
  }
  return value;
}

function shellQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new ProfexorError("SECURITY_POLICY", "Unsafe control character in launcher path");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function installUserService(
  projectRoot: string,
  paths: AppPaths,
  intervalMinutes: number,
): Promise<void> {
  const bunPath = Bun.which("bun") ?? process.execPath;
  if (!bunPath) {
    throw new ProfexorError("PROJECT_INVALID", "Bun is not available");
  }
  const unitDir = systemdDir();
  await mkdir(unitDir, { recursive: true, mode: 0o700 });
  const cli = join(projectRoot, "src", "cli.tsx");
  const userHome = homedir();
  const servicePath = [
    dirname(bunPath),
    join(userHome, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const service = `[Unit]
Description=Profexor Sync remote monitor
Documentation=https://github.com/jennofrie/profexor-sync

[Service]
Type=oneshot
WorkingDirectory=${unitPath(projectRoot)}
ExecStart=${unitQuote(bunPath)} ${unitQuote(cli)} --config ${unitQuote(paths.configFile)} check --all --json
Environment=${unitQuote(`PATH=${servicePath}`)}
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${unitPath(paths.stateDir)}
ReadWritePaths=${unitPath(paths.cacheDir)}
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=default.target
`;
  const timer = `[Unit]
Description=Check configured GitHub projects every ${intervalMinutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${intervalMinutes}min
Persistent=true
RandomizedDelaySec=30
Unit=profexor-sync-monitor.service

[Install]
WantedBy=timers.target
`;
  await writeFile(join(unitDir, "profexor-sync-monitor.service"), service, {
    mode: 0o644,
  });
  await writeFile(join(unitDir, "profexor-sync-monitor.timer"), timer, {
    mode: 0o644,
  });
  await runCommand("systemctl", ["--user", "daemon-reload"], {
    cwd: projectRoot,
  });
  await runCommand(
    "systemctl",
    ["--user", "enable", "--now", "profexor-sync-monitor.timer"],
    { cwd: projectRoot },
  );
}

export async function serviceStatus(projectRoot: string): Promise<string> {
  const result = await runCommand(
    "systemctl",
    [
      "--user",
      "status",
      "profexor-sync-monitor.timer",
      "--no-pager",
      "--lines=10",
    ],
    {
      cwd: projectRoot,
      allowedExitCodes: [0, 3, 4],
    },
  );
  return `${result.stdout}${result.stderr}`.trim();
}

export async function uninstallUserService(projectRoot: string): Promise<void> {
  await runCommand(
    "systemctl",
    ["--user", "disable", "--now", "profexor-sync-monitor.timer"],
    {
      cwd: projectRoot,
      allowedExitCodes: [0, 1, 5],
    },
  );
  const unitDir = systemdDir();
  for (const name of [
    "profexor-sync-monitor.service",
    "profexor-sync-monitor.timer",
  ]) {
    try {
      await unlink(join(unitDir, name));
    } catch {
      // Already absent.
    }
  }
  await runCommand("systemctl", ["--user", "daemon-reload"], {
    cwd: projectRoot,
  });
}

export async function ensureLauncher(projectRoot: string): Promise<string> {
  const binDir = join(process.env.HOME ?? "", ".local", "bin");
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  const launcherPath = join(binDir, "profsync");
  const bunPath = Bun.which("bun") ?? process.execPath;
  if (!bunPath) {
    throw new ProfexorError("PROJECT_INVALID", "Bun is not available");
  }
  const content = `#!/bin/sh
exec ${shellQuote(bunPath)} ${shellQuote(join(projectRoot, "src", "cli.tsx"))} "$@"
`;
  await writeFile(launcherPath, content, { mode: 0o755 });
  return launcherPath;
}
