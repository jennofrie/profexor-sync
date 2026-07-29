import { performance } from "node:perf_hooks";
import { ProfexorError } from "./errors.ts";
import { redactText, sanitizeArgs } from "./redaction.ts";
import type { CommandResult } from "./types.ts";

export type RunCommandOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  inheritEnv?: boolean;
  stdin?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  allowedExitCodes?: number[];
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
};

function streamLines(
  stream: ReadableStream<Uint8Array> | null,
  channel: "stdout" | "stderr",
  onLine?: RunCommandOptions["onLine"],
  maxOutputBytes = 16 * 1024 * 1024,
): Promise<string> {
  if (!stream) {
    return Promise.resolve("");
  }
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let buffered = "";
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (output.length < maxOutputBytes) {
        const remaining = maxOutputBytes - output.length;
        output += text.slice(0, remaining);
        truncated ||= text.length > remaining;
      } else {
        truncated = true;
      }
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(channel, redactText(line));
      }
    }
    const finalText = decoder.decode();
    if (output.length < maxOutputBytes) {
      output += finalText.slice(0, maxOutputBytes - output.length);
    } else if (finalText) {
      truncated = true;
    }
    if (buffered) {
      onLine?.(channel, redactText(buffered));
    }
    return redactText(
      truncated ? `${output}\n[output truncated by Profexor Sync]\n` : output,
    );
  })();
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout =
    options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);

  try {
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env:
        options.inheritEnv === false
          ? options.env ?? {}
          : options.env
            ? { ...process.env, ...options.env }
            : process.env,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    if (options.stdin !== undefined && subprocess.stdin) {
      subprocess.stdin.write(options.stdin);
      subprocess.stdin.end();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      streamLines(
        subprocess.stdout,
        "stdout",
        options.onLine,
        options.maxOutputBytes,
      ),
      streamLines(
        subprocess.stderr,
        "stderr",
        options.onLine,
        options.maxOutputBytes,
      ),
      subprocess.exited,
    ]);
    const result: CommandResult = {
      command,
      args: sanitizeArgs(args),
      cwd: options.cwd,
      exitCode,
      stdout,
      stderr,
      durationMs: Math.round(performance.now() - startedAt),
    };
    const allowed = options.allowedExitCodes ?? [0];
    if (!allowed.includes(exitCode)) {
      throw new ProfexorError(
        "COMMAND_FAILED",
        `${command} exited with code ${exitCode}`,
        {
          command,
          args: result.args,
          cwd: options.cwd,
          exitCode,
          stderr: stderr.slice(-4000),
        },
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ProfexorError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ProfexorError("COMMAND_FAILED", `${command} timed out`, {
        command,
        args: sanitizeArgs(args),
        timeoutSeconds: options.timeoutSeconds,
      });
    }
    throw new ProfexorError(
      "COMMAND_FAILED",
      `Unable to execute ${command}`,
      { command, args: sanitizeArgs(args), cwd: options.cwd },
      error,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
