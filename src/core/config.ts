import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ProfexorError } from "./errors.ts";
import type { AppConfig } from "./types.ts";

const RemoteRefSchema = z.object({
  remote: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  branch: z.string().min(1),
});

const ResourceLimitsSchema = z.object({
  cpus: z.number().positive().max(64),
  memory: z.string().regex(/^\d+(?:[kmg])?$/i),
  pids: z.number().int().positive().max(32768),
  timeoutSeconds: z.number().int().positive().max(21_600),
});

const ProjectSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().min(1),
  path: z.string().startsWith("/"),
  localBranch: z.string().min(1),
  source: RemoteRefSchema,
  destination: RemoteRefSchema,
  validator: z.object({
    kind: z.enum(["fexor", "grok"]),
    image: z.string().min(1),
    cacheVolume: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    resources: ResourceLimitsSchema,
  }),
});

const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    githubLogin: z.string().min(1),
  }),
  monitor: z.object({
    intervalMinutes: z.number().int().min(5).max(1440),
  }),
  advisor: z.object({
    enabled: z.boolean(),
    command: z.array(z.string().min(1)),
    timeoutSeconds: z.number().int().positive().max(3600),
    maxInputBytes: z.number().int().positive().max(5_000_000),
    allowedEnvironment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
  }),
  projects: z.array(ProjectSchema).min(1),
});

export async function loadConfig(path: string): Promise<AppConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ProfexorError("CONFIG_INVALID", "Configuration validation failed", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const ids = result.data.projects.map((project) => project.id);
    if (new Set(ids).size !== ids.length) {
      throw new ProfexorError("CONFIG_INVALID", "Project identifiers must be unique");
    }
    return result.data;
  } catch (error) {
    if (error instanceof ProfexorError) {
      throw error;
    }
    throw new ProfexorError(
      "CONFIG_INVALID",
      `Unable to load configuration at ${path}`,
      { path },
      error,
    );
  }
}

export async function writeDefaultConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const githubRoot = join(homedir(), "Desktop", "Github");
  const content = `schemaVersion: 1
identity:
  name: Profexor
  email: 58376175+jennofrie@users.noreply.github.com
  githubLogin: jennofrie
monitor:
  intervalMinutes: 15
advisor:
  enabled: false
  command: []
  timeoutSeconds: 120
  maxInputBytes: 200000
  allowedEnvironment: []
projects:
  - id: fexor-code
    label: Fexor Code
    path: ${JSON.stringify(join(githubRoot, "fexor-code"))}
    localBranch: main
    source:
      remote: origin
      branch: main
    destination:
      remote: origin
      branch: main
    validator:
      kind: fexor
      image: profexor-sync/bun-validator:1.3.14
      cacheVolume: profexor-sync-bun-cache
      resources:
        cpus: 4
        memory: 8g
        pids: 512
        timeoutSeconds: 1200
  - id: grok-build
    label: Grok Build
    path: ${JSON.stringify(join(githubRoot, "grok-build"))}
    localBranch: main
    source:
      remote: upstream
      branch: main
    destination:
      remote: origin
      branch: main
    validator:
      kind: grok
      image: profexor-sync/rust-validator:1.92
      cacheVolume: profexor-sync-cargo-cache
      resources:
        cpus: 8
        memory: 32g
        pids: 2048
        timeoutSeconds: 5400
`;
  await Bun.write(path, content);
  await chmod(path, 0o600);
}

export function findProject(config: AppConfig, id: string) {
  const project = config.projects.find((candidate) => candidate.id === id);
  if (!project) {
    throw new ProfexorError("PROJECT_INVALID", `Unknown project: ${id}`, { id });
  }
  return project;
}
