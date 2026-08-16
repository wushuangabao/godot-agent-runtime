import { spawn } from "node:child_process";

import { RuntimeFailure } from "./errors.js";

export interface ProcessResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const startedAt = performance.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - current.length;
      if (chunk.length > remaining) {
        truncated = true;
      }
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new RuntimeFailure({
          code: "PROCESS_SPAWN_FAILED",
          stage: "spawn",
          message: `Failed to start ${executable}.`,
          details: { executable, args, cause: error.message },
          recovery: [
            "Verify that the executable path exists and is runnable.",
            "Run doctor to inspect the configured development environment.",
          ],
        }),
      );
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        command: [executable, ...args],
        exitCode,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt),
        stdout: stdout.toString("utf8").trim(),
        stderr: stderr.toString("utf8").trim(),
        truncated,
      });
    });
  });
}
