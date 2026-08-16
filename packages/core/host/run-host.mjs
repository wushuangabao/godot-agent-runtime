import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const jobPath = process.argv[2];
if (!jobPath) process.exit(64);

const job = JSON.parse(readFileSync(jobPath, "utf8"));
if (existsSync(jobPath)) unlinkSync(jobPath);

function writeMetadata(metadata) {
  const temporaryPath = `${job.metadataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      renameSync(temporaryPath, job.metadataPath);
      return;
    } catch (error) {
      lastError = error;
      if (!(error && ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw lastError;
}

let metadata = {
  schemaVersion: 1,
  runId: job.runId,
  token: job.token,
  state: "starting",
  projectPath: job.projectPath,
  scene: job.scene,
  processId: null,
  supervisorProcessId: process.pid,
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  signal: null,
  command: [job.executable, ...job.args],
  stdoutPath: job.stdoutPath,
  stderrPath: job.stderrPath,
  runtimeBridgePort: job.runtimeBridgePort ?? null,
  failure: null,
};
writeMetadata(metadata);

const stdoutFd = openSync(job.stdoutPath, "a");
const stderrFd = openSync(job.stderrPath, "a");
let logsClosed = false;

function flushAndCloseLogs() {
  if (logsClosed) return;
  logsClosed = true;

  for (const fd of [stdoutFd, stderrFd]) {
    try {
      fsyncSync(fd);
    } catch {
      // A redirected descriptor can already be invalid during shutdown.
    }
    try {
      closeSync(fd);
    } catch {
      // Closing is best-effort during supervisor shutdown.
    }
  }
}

const child = spawn(job.executable, job.args, {
  cwd: job.cwd,
  env: job.env,
  windowsHide: false,
  stdio: ["ignore", stdoutFd, stderrFd],
});

let stopRequested = false;
let settled = false;
let forceStopTimer = null;

child.once("spawn", () => {
  metadata = { ...metadata, state: "running", processId: child.pid ?? null };
  writeMetadata(metadata);
});

child.once("error", (error) => {
  if (settled) return;
  settled = true;
  clearInterval(controlTimer);
  flushAndCloseLogs();
  metadata = {
    ...metadata,
    state: "failed",
    endedAt: new Date().toISOString(),
    failure: {
      code: "PROCESS_SPAWN_FAILED",
      stage: "spawn",
      message: `Failed to start ${job.executable}.`,
      details: { cause: error.message },
      recovery: ["Run godot_doctor and verify the configured executable."],
    },
  };
  writeMetadata(metadata);
});

const controlTimer = setInterval(() => {
  if (!existsSync(job.controlPath)) return;

  try {
    const request = JSON.parse(readFileSync(job.controlPath, "utf8"));
    unlinkSync(job.controlPath);
    if (request.token !== job.token || request.action !== "stop") return;
    if (settled || stopRequested) return;

    stopRequested = true;
    metadata = { ...metadata, state: "stopping" };
    writeMetadata(metadata);
    child.kill("SIGTERM");
    forceStopTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 5000);
  } catch {
    // A partial or stale control file is ignored; callers can retry idempotently.
  }
}, 100);

child.once("close", (exitCode, signal) => {
  if (settled) {
    clearInterval(controlTimer);
    flushAndCloseLogs();
    return;
  }
  settled = true;
  clearInterval(controlTimer);
  if (forceStopTimer !== null) clearTimeout(forceStopTimer);
  flushAndCloseLogs();
  metadata = {
    ...metadata,
    state: stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed",
    endedAt: new Date().toISOString(),
    exitCode,
    signal,
    ...(!stopRequested && exitCode !== 0
      ? {
          failure: {
            code: "GODOT_PROCESS_FAILED",
            stage: "run",
            message: `Godot exited with code ${String(exitCode)}.`,
            details: { signal },
            recovery: ["Read the bounded run logs and fix reported project errors."],
          },
        }
      : {}),
  };
  writeMetadata(metadata);
});

process.on("SIGTERM", () => {
  if (!settled) {
    stopRequested = true;
    child.kill("SIGTERM");
  }
});
