#!/usr/bin/env bun

import closeWithGrace from "close-with-grace";
import { createInterface } from "node:readline/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writeDefaultConfig } from "./core/config.ts";
import { SyncEngine } from "./core/engine.ts";
import { errorMessage, isProfexorError } from "./core/errors.ts";
import { createAppPaths } from "./core/paths.ts";
import { redactValue } from "./core/redaction.ts";
import {
  ensureLauncher,
  installUserService,
  serviceStatus,
  uninstallUserService,
} from "./core/service.ts";
import { StateStore } from "./core/state.ts";
import { launchTui } from "./ui/launch.tsx";

type ParsedArgs = {
  configPath?: string;
  command: string;
  rest: string[];
  json: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let configPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; ) {
    if (args[index] === "--config") {
      configPath = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    if (args[index] === "--json") {
      json = true;
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return {
    configPath,
    command: args.shift() ?? "tui",
    rest: args,
    json,
  };
}

function output(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(redactValue(value))}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(redactValue(value), null, 2)}\n`);
}

function projectRoot(): string {
  return resolve(import.meta.dirname, "..");
}

async function confirmProject(projectId: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Promotion requires an interactive terminal");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Type ${projectId} to fast-forward its GitHub main branch: `,
    );
    if (answer !== projectId) {
      throw new Error("Promotion confirmation did not match");
    }
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2));
  const paths = createAppPaths(parsed.configPath);

  if (parsed.command === "init") {
    try {
      await access(paths.configFile);
      output(`Configuration already exists: ${paths.configFile}`, parsed.json);
      return;
    } catch {
      await writeDefaultConfig(paths.configFile);
      output(`Created ${paths.configFile}`, parsed.json);
      return;
    }
  }

  const config = await loadConfig(paths.configFile);
  const state = await StateStore.open(paths);
  const graceful = closeWithGrace({ delay: 10_000, logger: false }, async () => {
    state.close();
  });
  const engine = new SyncEngine({
    config,
    paths,
    state,
    onActivity: parsed.json
      ? undefined
      : (line) => {
          if (parsed.command !== "tui") {
            process.stderr.write(`${line}\n`);
          }
        },
  });

  try {
    switch (parsed.command) {
      case "tui":
        await launchTui(config, state, engine);
        break;
      case "check": {
        const projectFlag = parsed.rest.indexOf("--project");
        const projectId = projectFlag >= 0 ? parsed.rest[projectFlag + 1] : undefined;
        const result = projectId
          ? [await engine.checkProject(projectId)]
          : await engine.checkAll();
        output(result, parsed.json);
        break;
      }
      case "prepare": {
        const projectId = parsed.rest[0];
        if (!projectId) {
          throw new Error("Usage: profsync prepare PROJECT_ID");
        }
        const run = await engine.prepare(projectId);
        output(run ?? { projectId, status: "up_to_date" }, parsed.json);
        break;
      }
      case "continue": {
        const runId = parsed.rest[0];
        if (!runId) {
          throw new Error("Usage: profsync continue RUN_ID [--mergiraf]");
        }
        output(
          await engine.continueAfterConflicts(
            runId,
            parsed.rest.includes("--mergiraf"),
          ),
          parsed.json,
        );
        break;
      }
      case "validate": {
        const runId = parsed.rest[0];
        if (!runId) {
          throw new Error("Usage: profsync validate RUN_ID");
        }
        output(await engine.validate(runId), parsed.json);
        break;
      }
      case "advise": {
        const runId = parsed.rest[0];
        if (!runId) {
          throw new Error("Usage: profsync advise RUN_ID");
        }
        output(await engine.advise(runId), parsed.json);
        break;
      }
      case "apply-advice": {
        const runId = parsed.rest[0];
        const patchIndex = Number(parsed.rest[1]);
        if (!runId || !Number.isInteger(patchIndex)) {
          throw new Error("Usage: profsync apply-advice RUN_ID PATCH_INDEX");
        }
        if (!process.stdin.isTTY) {
          throw new Error("Applying Advisor patches requires an interactive terminal");
        }
        output(await engine.applyAdvisorPatch(runId, patchIndex), parsed.json);
        break;
      }
      case "promote": {
        const runId = parsed.rest[0];
        if (!runId) {
          throw new Error("Usage: profsync promote RUN_ID");
        }
        const run = engine.requireRun(runId);
        await confirmProject(run.projectId);
        output(await engine.promote(runId), parsed.json);
        break;
      }
      case "discard": {
        const runId = parsed.rest[0];
        if (!runId) {
          throw new Error("Usage: profsync discard RUN_ID");
        }
        await engine.discard(runId);
        output({ runId, status: "discarded" }, parsed.json);
        break;
      }
      case "history": {
        const projectId = parsed.rest[0];
        output(state.listRuns(projectId, 100), parsed.json);
        break;
      }
      case "doctor":
        output(await engine.doctor(), parsed.json);
        break;
      case "service": {
        const action = parsed.rest[0] ?? "status";
        if (action === "install") {
          const launcher = await ensureLauncher(projectRoot());
          await installUserService(
            projectRoot(),
            paths,
            config.monitor.intervalMinutes,
          );
          output({ launcher, timer: "profexor-sync-monitor.timer" }, parsed.json);
        } else if (action === "uninstall") {
          await uninstallUserService(projectRoot());
          output("Profexor Sync timer removed; state and source were retained.", parsed.json);
        } else if (action === "status") {
          output(await serviceStatus(projectRoot()), parsed.json);
        } else {
          throw new Error("Usage: profsync service install|status|uninstall");
        }
        break;
      }
      default:
        throw new Error(
          "Commands: tui, init, check, prepare, continue, validate, advise, apply-advice, promote, discard, history, doctor, service",
        );
    }
  } finally {
    graceful.uninstall();
    state.close();
  }
}

main().catch((error) => {
  const payload = isProfexorError(error)
    ? {
        error: {
          code: error.code,
          message: error.message,
          details: redactValue(error.details),
        },
      }
    : {
        error: {
          code: "UNEXPECTED",
          message: errorMessage(error),
        },
      };
  if (Bun.argv.includes("--json")) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`Profexor Sync: ${payload.error.message}\n`);
  }
  process.exitCode = 1;
});
