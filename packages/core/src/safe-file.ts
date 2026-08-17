import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type {
  FileMutationGuard,
  SafeFileReadResult,
  SafeFileWriteResult,
} from "@godot-agent-runtime/protocol";

export type { FileMutationGuard } from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { assertProjectFingerprint } from "./project.js";
import {
  ensureSafeProjectDirectory,
  resolveSafeTarget,
  type SafeProjectTarget,
} from "./safe-path.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MUTATION_HEARTBEAT_MS = 5_000;
const DEFAULT_MUTATION_STALE_TTL_MS = 120_000;
const DEFAULT_MUTATION_QUARANTINE_MS = 120_000;
const DEFAULT_MUTATION_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_POLL_MS = 50;

export interface MutationLeaseTiming {
  readonly heartbeatMs: number;
  readonly staleTtlMs: number;
  readonly quarantineMs: number;
  readonly acquireTimeoutMs: number;
  readonly pollMs: number;
}

const DEFAULT_MUTATION_TIMING: MutationLeaseTiming = {
  heartbeatMs: DEFAULT_MUTATION_HEARTBEAT_MS,
  staleTtlMs: DEFAULT_MUTATION_STALE_TTL_MS,
  quarantineMs: DEFAULT_MUTATION_QUARANTINE_MS,
  acquireTimeoutMs: DEFAULT_MUTATION_ACQUIRE_TIMEOUT_MS,
  pollMs: DEFAULT_MUTATION_POLL_MS,
};

export interface SafeFileOptions {
  readonly projectPath: string;
  readonly path: string;
  readonly maxBytes?: number;
}

export interface SafeFileWriteOptions extends SafeFileOptions {
  readonly content: string;
  readonly guard?: FileMutationGuard;
  readonly expectedSha256?: string | null;
  readonly expectedProjectFingerprint?: string;
  readonly createDirectories?: boolean;
}

export interface SafeTextReplaceOptions extends SafeFileOptions {
  readonly expectedProjectFingerprint: string;
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export interface ProjectMutationLockOptions extends SafeFileOptions {
  readonly expectedProjectFingerprint?: string;
}

export interface SafeFileTestHooks {
  readonly timing?: Partial<MutationLeaseTiming>;
  readonly beforePathOperation?: (event: {
    readonly operation: SafeFilePathOperation;
    readonly paths: readonly string[];
  }) => void | Promise<void>;
}

export type SafeFilePathOperation =
  | "lease_stage_open"
  | "lease_publish_link"
  | "lease_replace_rename"
  | "lease_prepare_publish_rename"
  | "reclaim_stage_open"
  | "reclaim_publish_link"
  | "reclaim_before_lease_unlink"
  | "reclaim_cleanup_unlink"
  | "record_unlink"
  | "target_temp_open"
  | "target_read_open"
  | "target_temp_cleanup"
  | "target_publish_link"
  | "target_publish_rename";

export interface ProjectMutationLease extends SafeProjectTarget {
  prepareResultUnknown(): Promise<string>;
  markResultUnknown(): string;
}

interface MutationLeaseRecord {
  readonly version: 1;
  readonly key: string;
  readonly resourcePath: string;
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly state: "active" | "publishing" | "quarantined";
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly quarantineUntil: number | null;
}

interface MutationReclaimRecord {
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly observedOwnerNonce: string;
  readonly claimedAt: number;
  readonly expiresAt: number;
}

interface AcquiredMutationLease {
  readonly lockPath: string;
  readonly timing: MutationLeaseTiming;
  readonly record: MutationLeaseRecord;
  stopHeartbeat(): Promise<void>;
}

let safeFileTestHooks: SafeFileTestHooks | undefined;

export function __setSafeFileTestHooks(hooks: SafeFileTestHooks | undefined): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw fileFailure(
      "FILE_TEST_HOOK_FORBIDDEN",
      "Safe-file test hooks are only available to the internal test harness.",
    );
  }
  const previous = safeFileTestHooks;
  safeFileTestHooks = hooks;
  return () => { safeFileTestHooks = previous; };
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  recovery = ["Read the current project file state and retry with an explicit mutation guard."],
): RuntimeFailure {
  return new RuntimeFailure({
    code,
    stage: "validation",
    message,
    ...(details === undefined ? {} : { details }),
    recovery,
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nodeErrorDiagnostic(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function atPathOperationBoundary<T>(
  operation: SafeFilePathOperation,
  paths: readonly string[],
  action: () => Promise<T>,
  revalidate?: () => Promise<void>,
): Promise<T> {
  await safeFileTestHooks?.beforePathOperation?.({ operation, paths });
  await revalidate?.();
  return await action();
}

function mutationTiming(): MutationLeaseTiming {
  if (safeFileTestHooks?.timing === undefined) return DEFAULT_MUTATION_TIMING;
  const timing = { ...DEFAULT_MUTATION_TIMING, ...safeFileTestHooks.timing };
  if (Object.values(timing).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw fileFailure("FILE_MUTATION_TIMING_INVALID", "Mutation lease timings must be positive.");
  }
  return timing;
}

function leaseKey(projectRoot: string, relativePath: string): string {
  const canonicalKey = process.platform === "win32"
    ? `${projectRoot}\0${relativePath}`.toLowerCase()
    : `${projectRoot}\0${relativePath}`;
  return sha256(canonicalKey);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function readLeaseRecord(path: string): Promise<MutationLeaseRecord | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const value = JSON.parse(source) as Partial<MutationLeaseRecord>;
    if (
      value.version !== 1 ||
      typeof value.key !== "string" ||
      typeof value.resourcePath !== "string" ||
      typeof value.ownerNonce !== "string" ||
      !Number.isInteger(value.ownerPid) ||
      (value.state !== "active" && value.state !== "publishing" && value.state !== "quarantined") ||
      typeof value.acquiredAt !== "number" ||
      typeof value.heartbeatAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      !(value.quarantineUntil === null || typeof value.quarantineUntil === "number")
    ) {
      return null;
    }
    return value as MutationLeaseRecord;
  } catch {
    return null;
  }
}

async function readReclaimRecord(path: string): Promise<MutationReclaimRecord | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const value = JSON.parse(source) as Partial<MutationReclaimRecord>;
    if (
      typeof value.ownerNonce !== "string" ||
      !Number.isInteger(value.ownerPid) ||
      typeof value.observedOwnerNonce !== "string" ||
      typeof value.claimedAt !== "number" ||
      typeof value.expiresAt !== "number"
    ) {
      return null;
    }
    return value as MutationReclaimRecord;
  } catch {
    return null;
  }
}

async function bestEffortRemove(
  path: string,
  operation: SafeFilePathOperation,
): Promise<void> {
  try {
    await atPathOperationBoundary(operation, [path], async () => {
      await rm(path, { force: true });
    });
  } catch {
    // Cleanup is intentionally best-effort so it never replaces the mutation's
    // structured success/failure result. Stale stages are never authoritative.
  }
}

async function writeFlushedJsonStage(
  stagePath: string,
  record: MutationLeaseRecord | MutationReclaimRecord,
  operation: "lease_stage_open" | "reclaim_stage_open",
): Promise<void> {
  const handle = await atPathOperationBoundary(
    operation,
    [stagePath],
    async () => await open(stagePath, "wx", 0o600),
  );
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishJsonRecordNoReplace(
  finalPath: string,
  record: MutationLeaseRecord | MutationReclaimRecord,
  kind: "lease" | "reclaim",
): Promise<void> {
  const stagePath = `${finalPath}.${kind}-stage-${randomUUID()}`;
  try {
    await writeFlushedJsonStage(
      stagePath,
      record,
      kind === "lease" ? "lease_stage_open" : "reclaim_stage_open",
    );
    try {
      await atPathOperationBoundary(
        kind === "lease" ? "lease_publish_link" : "reclaim_publish_link",
        [stagePath, finalPath],
        async () => await link(stagePath, finalPath),
      );
    } catch (error) {
      const unsupportedCodes = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EPERM"]);
      const diagnostic = nodeErrorDiagnostic(error);
      if (unsupportedCodes.has(diagnostic.code)) {
        throw fileFailure(
          "FILE_LOCK_CAPABILITY_UNAVAILABLE",
          "The project filesystem cannot publish mutation lock records with hard links.",
          { recordKind: kind, cause: diagnostic.message, causeCode: diagnostic.code },
          ["Move the project to a local filesystem that supports same-directory hard links."],
        );
      }
      throw error;
    }
  } finally {
    await bestEffortRemove(stagePath, "record_unlink");
  }
}

async function replaceOwnedLease(
  lockPath: string,
  ownerNonce: string,
  operation: "lease_replace_rename" | "lease_prepare_publish_rename",
  update: (record: MutationLeaseRecord) => MutationLeaseRecord,
): Promise<boolean> {
  const current = await readLeaseRecord(lockPath);
  if (current?.ownerNonce !== ownerNonce) return false;
  const temporary = `${lockPath}.${ownerNonce}.${randomUUID()}.tmp`;
  const next = update(current);
  try {
    await writeFlushedJsonStage(temporary, next, "lease_stage_open");
    const confirmed = await readLeaseRecord(lockPath);
    if (confirmed?.ownerNonce !== ownerNonce) return false;
    await atPathOperationBoundary(
      operation,
      [temporary, lockPath],
      async () => await rename(temporary, lockPath),
    );
    return true;
  } finally {
    await bestEffortRemove(temporary, "record_unlink");
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function canReclaimLease(record: MutationLeaseRecord, now: number): boolean {
  if (record.state === "publishing") {
    return !isProcessAlive(record.ownerPid) &&
      record.quarantineUntil !== null &&
      now >= record.quarantineUntil;
  }
  if (record.state === "quarantined") {
    return record.quarantineUntil !== null && now >= record.quarantineUntil;
  }
  return !isProcessAlive(record.ownerPid) && now >= record.expiresAt;
}

async function clearStaleMalformedRecord(
  path: string,
  staleTtlMs: number,
  readRecord: (path: string) => Promise<MutationLeaseRecord | MutationReclaimRecord | null>,
): Promise<boolean> {
  let observed;
  try {
    observed = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  if (
    observed.isSymbolicLink() ||
    !observed.isFile() ||
    Date.now() < observed.mtimeMs + staleTtlMs ||
    await readRecord(path) !== null
  ) {
    return false;
  }
  return await atPathOperationBoundary(
    "record_unlink",
    [path],
    async () => {
      let confirmed;
      try {
        confirmed = await lstat(path);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return true;
        throw error;
      }
      if (
        confirmed.isSymbolicLink() ||
        !confirmed.isFile() ||
        String(confirmed.dev) !== String(observed.dev) ||
        String(confirmed.ino) !== String(observed.ino) ||
        confirmed.size !== observed.size ||
        confirmed.mtimeMs !== observed.mtimeMs ||
        await readRecord(path) !== null
      ) {
        return false;
      }
      await unlink(path);
      return true;
    },
  );
}

async function releaseOwnedLease(
  lockPath: string,
  ownerNonce: string,
): Promise<void> {
  const current = await readLeaseRecord(lockPath);
  if (current?.ownerNonce === ownerNonce) {
    await atPathOperationBoundary("record_unlink", [lockPath], async () => {
      await unlink(lockPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    });
  }
}

async function clearAbandonedReclaim(
  reclaimPath: string,
  timing: MutationLeaseTiming,
): Promise<boolean> {
  const observed = await readReclaimRecord(reclaimPath);
  if (observed === null && await pathExists(reclaimPath)) {
    return await clearStaleMalformedRecord(
      reclaimPath,
      timing.staleTtlMs,
      readReclaimRecord,
    );
  }
  if (
    observed === null ||
    isProcessAlive(observed.ownerPid) ||
    Date.now() < observed.expiresAt
  ) {
    return false;
  }
  return await atPathOperationBoundary("record_unlink", [reclaimPath], async () => {
    const confirmed = await readReclaimRecord(reclaimPath);
    if (
      confirmed?.ownerNonce !== observed.ownerNonce ||
      isProcessAlive(confirmed.ownerPid) ||
      Date.now() < confirmed.expiresAt
    ) {
      return false;
    }
    await unlink(reclaimPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    return true;
  });
}

async function removeOwnedReclaim(reclaimPath: string, ownerNonce: string): Promise<void> {
  try {
    await atPathOperationBoundary(
      "reclaim_cleanup_unlink",
      [reclaimPath],
      async () => {
        const current = await readReclaimRecord(reclaimPath);
        if (current?.ownerNonce !== ownerNonce) return;
        await unlink(reclaimPath).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      },
    );
  } catch {
    // A reclaim cleanup is non-authoritative once its nonce is no longer current.
  }
}

async function tryReclaimLease(
  lockPath: string,
  reclaimPath: string,
  timing: MutationLeaseTiming,
): Promise<boolean> {
  const observed = await readLeaseRecord(lockPath);
  if (observed === null) {
    if (!await pathExists(lockPath)) return true;
    return await clearStaleMalformedRecord(
      lockPath,
      timing.staleTtlMs,
      readLeaseRecord,
    );
  }
  if (!canReclaimLease(observed, Date.now())) return false;

  const claim: MutationReclaimRecord = {
    ownerNonce: randomUUID(),
    ownerPid: process.pid,
    observedOwnerNonce: observed.ownerNonce,
    claimedAt: Date.now(),
    expiresAt: Date.now() + timing.staleTtlMs,
  };
  try {
    await publishJsonRecordNoReplace(reclaimPath, claim, "reclaim");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      await clearAbandonedReclaim(reclaimPath, timing);
      return false;
    }
    throw error;
  }

  try {
    return await atPathOperationBoundary(
      "reclaim_before_lease_unlink",
      [lockPath, reclaimPath],
      async () => {
        const ownedClaim = await readReclaimRecord(reclaimPath);
        if (
          ownedClaim?.ownerNonce !== claim.ownerNonce ||
          Date.now() >= ownedClaim.expiresAt
        ) {
          return false;
        }
        const confirmed = await readLeaseRecord(lockPath);
        if (
          confirmed?.ownerNonce !== observed.ownerNonce ||
          !canReclaimLease(confirmed, Date.now())
        ) {
          return false;
        }
        await unlink(lockPath);
        return true;
      },
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  } finally {
    await removeOwnedReclaim(reclaimPath, claim.ownerNonce);
  }
}

function startLeaseHeartbeat(
  lockPath: string,
  record: MutationLeaseRecord,
  timing: MutationLeaseTiming,
): () => Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      const now = Date.now();
      await replaceOwnedLease(
        lockPath,
        record.ownerNonce,
        "lease_replace_rename",
        (current) => ({
          ...current,
          heartbeatAt: now,
          expiresAt: now + timing.staleTtlMs,
        }),
      );
    }).catch(() => undefined);
  }, timing.heartbeatMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

async function acquireMutationLease(
  target: SafeProjectTarget,
  timing: MutationLeaseTiming,
): Promise<AcquiredMutationLease> {
  const lockDirectory = await ensureSafeProjectDirectory(
    target.projectRoot,
    ".godot/agent-runtime/locks",
  );
  const key = leaseKey(target.projectRoot, target.relativePath);
  const lockPath = resolve(lockDirectory, `${key}.lease`);
  const reclaimPath = resolve(lockDirectory, `${key}.reclaim`);
  const deadline = Date.now() + timing.acquireTimeoutMs;

  while (true) {
    const now = Date.now();
    const record: MutationLeaseRecord = {
      version: 1,
      key,
      resourcePath: `res://${target.relativePath}`,
      ownerNonce: randomUUID(),
      ownerPid: process.pid,
      state: "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + timing.staleTtlMs,
      quarantineUntil: null,
    };
    try {
      await publishJsonRecordNoReplace(lockPath, record, "lease");
      if (await pathExists(reclaimPath)) {
        if (!(await clearAbandonedReclaim(reclaimPath, timing))) {
          await releaseOwnedLease(lockPath, record.ownerNonce);
        } else {
          return {
            lockPath,
            timing,
            record,
            stopHeartbeat: startLeaseHeartbeat(lockPath, record, timing),
          };
        }
      } else {
        return {
          lockPath,
          timing,
          record,
          stopHeartbeat: startLeaseHeartbeat(lockPath, record, timing),
        };
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await tryReclaimLease(lockPath, reclaimPath, timing);
    }

    if (Date.now() >= deadline) {
      throw fileFailure(
        "FILE_MUTATION_BUSY",
        `Timed out waiting for the mutation lease for res://${target.relativePath}.`,
        { path: `res://${target.relativePath}`, waitMs: timing.acquireTimeoutMs },
        ["Retry after the active mutation finishes or reconcile a quarantined result."],
      );
    }
    await new Promise((complete) => setTimeout(complete, timing.pollMs));
  }
}

export async function withProjectMutationLock<T>(
  options: ProjectMutationLockOptions,
  operation: (lease: ProjectMutationLease) => Promise<T>,
): Promise<T> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  const target = await resolveSafeTarget(options.projectPath, options.path, true);
  const acquired = await acquireMutationLease(target, mutationTiming());
  let resultUnknown = false;
  let quarantineUntil = 0;
  let heartbeatStopped = false;
  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    await acquired.stopHeartbeat();
  };
  let completed = false;
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await operation({
      ...target,
      prepareResultUnknown: async () => {
        if (quarantineUntil > 0) return new Date(quarantineUntil).toISOString();
        // Drain the owner heartbeat before changing active -> publishing so an
        // already-started refresh cannot replace the persisted quarantine state.
        await stopHeartbeat();
        const preparedUntil = Date.now() + acquired.timing.quarantineMs;
        const persisted = await replaceOwnedLease(
          acquired.lockPath,
          acquired.record.ownerNonce,
          "lease_prepare_publish_rename",
          (current) => ({
            ...current,
            state: "publishing",
            heartbeatAt: Date.now(),
            expiresAt: Math.max(current.expiresAt, preparedUntil),
            quarantineUntil: preparedUntil,
          }),
        );
        if (!persisted) {
          throw fileFailure(
            "FILE_QUARANTINE_PERSIST_FAILED",
            "The mutation lease changed before its result quarantine could be persisted.",
            { path: `res://${target.relativePath}` },
            ["Retry only after reading and reconciling the current file and lease state."],
          );
        }
        quarantineUntil = preparedUntil;
        return new Date(quarantineUntil).toISOString();
      },
      markResultUnknown: () => {
        if (quarantineUntil === 0) {
          throw fileFailure(
            "FILE_QUARANTINE_NOT_PREPARED",
            "An unknown publish result cannot be reported before its quarantine is persisted.",
            { path: `res://${target.relativePath}` },
          );
        }
        resultUnknown = true;
        quarantineUntil = Math.max(
          quarantineUntil,
          Date.now() + acquired.timing.quarantineMs,
        );
        return new Date(quarantineUntil).toISOString();
      },
    });
    completed = true;
  } catch (error) {
    primaryError = error;
  }

  let coordinationError: unknown;
  try {
    await stopHeartbeat();
    if (resultUnknown) {
      const persisted = await replaceOwnedLease(
        acquired.lockPath,
        acquired.record.ownerNonce,
        "lease_replace_rename",
        (current) => ({
          ...current,
          state: "quarantined",
          expiresAt: Math.max(current.expiresAt, quarantineUntil),
          quarantineUntil,
        }),
      );
      if (!persisted) {
        throw fileFailure(
          "FILE_QUARANTINE_PERSIST_FAILED",
          "The unknown mutation result could not be transitioned to quarantine.",
          { path: `res://${target.relativePath}`, quarantineUntil },
          ["Read and reconcile the target and lease state before retrying."],
        );
      }
    } else {
      await releaseOwnedLease(
        acquired.lockPath,
        acquired.record.ownerNonce,
      );
    }
  } catch (error) {
    coordinationError = error;
  }

  if (coordinationError !== undefined) {
    const diagnostic = nodeErrorDiagnostic(coordinationError);
    if (resultUnknown) {
      const actualLease = await readLeaseRecord(acquired.lockPath).catch(() => null);
      const unknownCause = primaryError instanceof RuntimeFailure
        ? primaryError.payload.details?.cause ?? primaryError.payload.message
        : primaryError instanceof Error
          ? primaryError.message
          : "The file publish result was unknown.";
      const actualOwnerPid = actualLease?.ownerPid ?? acquired.record.ownerPid;
      const actualOwnerNonce = actualLease?.ownerNonce ?? acquired.record.ownerNonce;
      const actualQuarantineUntil = actualLease?.quarantineUntil ?? quarantineUntil;
      const quarantineDeadline = new Date(actualQuarantineUntil).toISOString();
      throw fileFailure(
        "FILE_QUARANTINE_PERSIST_FAILED",
        "The publish result is unknown and its lease remains in publishing state.",
        {
          path: `res://${target.relativePath}`,
          cause: unknownCause,
          leaseState: actualLease?.state ?? "unknown",
          ownerPid: actualOwnerPid,
          ownerNonce: actualOwnerNonce,
          quarantineUntil: quarantineDeadline,
          requiresProcessRestart: actualLease?.state === "publishing",
          coordinationQuarantine: diagnostic,
        },
        [
          `Stop or restart the MCP/CLI owner process with PID ${actualOwnerPid}.`,
          `After that PID is no longer running and quarantineUntil ${quarantineDeadline} has passed, read and reconcile the target before retrying.`,
        ],
      );
    }
    if (!completed && primaryError instanceof RuntimeFailure) {
      throw new RuntimeFailure({
        ...primaryError.payload,
        details: {
          ...primaryError.payload.details,
          coordinationRelease: diagnostic,
        },
        recovery: [
          ...primaryError.payload.recovery,
          "The mutation lease could not be released; reconcile the reported file state before retrying.",
        ],
      });
    }
    if (!completed && primaryError !== undefined) throw primaryError;
    throw fileFailure(
      "FILE_MUTATION_RELEASE_FAILED",
      "The file operation was applied, but its mutation lease could not be released.",
      {
        applied: true,
        receipt: result,
        coordinationRelease: diagnostic,
      },
      ["Treat the receipt as applied, read the current file state, and retry only after reconciliation."],
    );
  }

  if (!completed) throw primaryError;
  return result as T;
}

function expectedReceipt(options: SafeFileWriteOptions): string | null {
  if (options.guard !== undefined && options.expectedSha256 !== undefined) {
    throw fileFailure("FILE_GUARD_CONFLICT", "Provide guard or expectedSha256, not both.");
  }
  if (options.guard?.mode === "create") return null;
  if (options.guard?.mode === "match") return options.guard.sha256;
  if (options.expectedSha256 !== undefined) return options.expectedSha256;
  throw fileFailure("FILE_GUARD_REQUIRED", "A create or SHA-256 match guard is required.");
}

export async function readProjectFile(
  options: SafeFileOptions,
): Promise<SafeFileReadResult> {
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { projectRoot, target, relativePath } = await resolveSafeTarget(
    options.projectPath,
    options.path,
    false,
  );
  const information = await stat(target);
  if (!information.isFile() || information.size > maximum) {
    throw new RuntimeFailure({
      code: information.isFile() ? "FILE_TOO_LARGE" : "FILE_NOT_REGULAR",
      stage: "validation",
      message: information.isFile()
        ? `Project file exceeds the ${maximum} byte read limit.`
        : "The requested path is not a regular file.",
      details: { path: relativePath, size: information.size, maxBytes: maximum },
      recovery: ["Choose a regular text file within the configured size limit."],
    });
  }
  const handle = await atPathOperationBoundary(
    "target_read_open",
    [target],
    async () => await open(target, "r"),
  );
  const boundedBuffer = Buffer.allocUnsafe(maximum + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < boundedBuffer.length) {
      const read = await handle.read(
        boundedBuffer,
        bytesRead,
        boundedBuffer.length - bytesRead,
        null,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytesRead > maximum) {
    throw new RuntimeFailure({
      code: "FILE_TOO_LARGE",
      stage: "validation",
      message: `Project file exceeds the ${maximum} byte read limit.`,
      details: {
        phase: "actual_read",
        path: relativePath,
        size: bytesRead,
        maxBytes: maximum,
      },
      recovery: ["Reduce the file below the configured UTF-8 text read limit and retry."],
    });
  }
  const buffer = boundedBuffer.subarray(0, bytesRead);
  if (buffer.includes(0)) {
    throw new RuntimeFailure({
      code: "FILE_BINARY_REJECTED",
      stage: "validation",
      message: "The safe file API only reads UTF-8 text files.",
      details: { path: relativePath },
      recovery: ["Use Godot resource APIs for binary assets."],
    });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new RuntimeFailure({
      code: "FILE_INVALID_UTF8",
      stage: "validation",
      message: "The project file is not valid UTF-8 text.",
      details: {
        path: relativePath,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Convert the file to valid UTF-8 or use a binary resource API."],
    });
  }
  return {
    ok: true,
    projectPath: projectRoot,
    path: `res://${relativePath}`,
    bytes: buffer.length,
    sha256: sha256(buffer),
    content,
  };
}

async function readExistingTarget(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function writeFlushedTemporary(
  path: string,
  content: Buffer,
  target: SafeProjectTarget,
): Promise<void> {
  const handle = await atPathOperationBoundary(
    "target_temp_open",
    [path],
    async () => await open(path, "wx", 0o666),
    async () => {
      await resolveSafeTarget(target.projectRoot, `res://${target.relativePath}`, true);
    },
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function reconciledTargetHash(target: string): Promise<string | null | undefined> {
  try {
    const content = await readExistingTarget(target);
    return content === null ? null : sha256(content);
  } catch {
    return undefined;
  }
}

export async function writeProjectFile(
  options: SafeFileWriteOptions,
): Promise<SafeFileWriteResult> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const content = Buffer.from(options.content, "utf8");
  if (content.length > maximum || content.includes(0)) {
    throw new RuntimeFailure({
      code: content.length > maximum ? "FILE_TOO_LARGE" : "FILE_BINARY_REJECTED",
      stage: "validation",
      message: content.length > maximum
        ? `Content exceeds the ${maximum} byte write limit.`
        : "NUL bytes are not accepted by the safe text API.",
      details: { path: options.path, bytes: content.length, maxBytes: maximum },
      recovery: ["Write bounded UTF-8 text content only."],
    });
  }

  const initialTarget = await resolveSafeTarget(
    options.projectPath,
    options.path,
    true,
  );
  const expectedSha256 = expectedReceipt(options);
  return await withProjectMutationLock({
    projectPath: initialTarget.projectRoot,
    path: `res://${initialTarget.relativePath}`,
    ...(options.expectedProjectFingerprint === undefined
      ? {}
      : { expectedProjectFingerprint: options.expectedProjectFingerprint }),
  }, async (lease) => {
    if (options.createDirectories) {
      await ensureSafeProjectDirectory(
        lease.projectRoot,
        relative(lease.projectRoot, dirname(lease.target)),
      );
    }
    const lockedTarget = await resolveSafeTarget(
      lease.projectRoot,
      `res://${lease.relativePath}`,
      true,
    );
    const temporary = resolve(
      dirname(lockedTarget.target),
      `.${lockedTarget.relativePath.split("/").at(-1)}.${randomUUID()}.tmp`,
    );
    const nextSha256 = sha256(content);
    try {
      try {
        await writeFlushedTemporary(temporary, content, lockedTarget);
      } catch (error) {
        throw fileFailure(
          "FILE_WRITE_FAILED",
          `Failed to prepare a flushed temporary file for res://${lockedTarget.relativePath}.`,
          { cause: error instanceof Error ? error.message : String(error) },
          ["Verify that the parent directory exists and is writable, then retry."],
        );
      }

      const previous = await readExistingTarget(lockedTarget.target);
      const previousSha256 = previous === null ? null : sha256(previous);
      if (expectedSha256 === null && previous !== null) {
        throw fileFailure(
          "FILE_ALREADY_EXISTS",
          "The create guard was not applied because the target already exists.",
          { path: `res://${lockedTarget.relativePath}`, actualSha256: previousSha256 },
          ["Read the existing file and retry with a SHA-256 match guard if an update is intended."],
        );
      }
      if (expectedSha256 !== null && expectedSha256 !== previousSha256) {
        throw fileFailure(
          "FILE_WRITE_CONFLICT",
          "The file changed since it was read, so the write was not applied.",
          {
            path: `res://${lockedTarget.relativePath}`,
            expectedSha256,
            actualSha256: previousSha256,
          },
          ["Read the file again, incorporate the current content, and retry with its SHA-256."],
        );
      }

      try {
        await lease.prepareResultUnknown();
      } catch (error) {
        if (error instanceof RuntimeFailure && error.payload.code === "FILE_QUARANTINE_PERSIST_FAILED") {
          throw error;
        }
        throw fileFailure(
          "FILE_QUARANTINE_PERSIST_FAILED",
          `Failed to persist the result quarantine before publishing res://${lockedTarget.relativePath}.`,
          { cause: error instanceof Error ? error.message : String(error) },
          ["Read and reconcile the current target and lease state before retrying."],
        );
      }

      try {
        if (expectedSha256 === null) {
          await atPathOperationBoundary(
            "target_publish_link",
            [temporary, lockedTarget.target],
            async () => await link(temporary, lockedTarget.target),
            async () => {
              await resolveSafeTarget(
                lockedTarget.projectRoot,
                `res://${lockedTarget.relativePath}`,
                true,
              );
            },
          );
        } else {
          await atPathOperationBoundary(
            "target_publish_rename",
            [temporary, lockedTarget.target],
            async () => await rename(temporary, lockedTarget.target),
            async () => {
              await resolveSafeTarget(
                lockedTarget.projectRoot,
                `res://${lockedTarget.relativePath}`,
                true,
              );
            },
          );
        }
      } catch (error) {
        if (error instanceof RuntimeFailure) throw error;
        if (expectedSha256 === null && isNodeError(error, "EEXIST")) {
          throw fileFailure(
            "FILE_ALREADY_EXISTS",
            "Another writer created the target before this create could publish.",
            { path: `res://${lockedTarget.relativePath}` },
            ["Read the existing file before deciding whether to update it."],
          );
        }
        const actualSha256 = await reconciledTargetHash(lockedTarget.target);
        if (actualSha256 !== nextSha256) {
          if (actualSha256 === previousSha256) {
            throw fileFailure(
              "FILE_WRITE_FAILED",
              `Failed to publish res://${lockedTarget.relativePath}.`,
              { cause: error instanceof Error ? error.message : String(error) },
              ["Verify that the target is writable, then retry with the same guard."],
            );
          }
          const quarantineUntil = lease.markResultUnknown();
          throw fileFailure(
            "FILE_WRITE_RESULT_UNKNOWN",
            `The publish result for res://${lockedTarget.relativePath} could not be reconciled.`,
            {
              cause: error instanceof Error ? error.message : String(error),
              actualSha256,
              quarantineUntil,
            },
            [
              "Read and reconcile the target before retrying.",
              "Do not remove the quarantined mutation lease before quarantineUntil.",
            ],
          );
        }
      }

      return {
        ok: true,
        projectPath: lockedTarget.projectRoot,
        path: `res://${lockedTarget.relativePath}`,
        operation: expectedSha256 === null ? "created" : "updated",
        bytes: content.length,
        sha256: nextSha256,
        previousSha256,
      };
    } finally {
      await bestEffortRemove(temporary, "target_temp_cleanup");
    }
  });
}

export async function replaceProjectText(
  options: SafeTextReplaceOptions,
): Promise<SafeFileWriteResult & { replacements: number }> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  if (options.oldText.length === 0) {
    throw fileFailure("FILE_REPLACE_TEXT_EMPTY", "oldText must not be empty.");
  }
  const before = await readProjectFile(options);
  let occurrences = 0;
  let searchOffset = 0;
  while (true) {
    const matchOffset = before.content.indexOf(options.oldText, searchOffset);
    if (matchOffset === -1) break;
    occurrences += 1;
    searchOffset = matchOffset + options.oldText.length;
  }
  if (occurrences === 0) {
    throw fileFailure("FILE_REPLACE_NOT_FOUND", "oldText was not found.");
  }
  if (!options.replaceAll && occurrences !== 1) {
    throw fileFailure(
      "FILE_REPLACE_AMBIGUOUS",
      "oldText must match exactly once unless replaceAll is true.",
    );
  }
  const replacements = options.replaceAll ? occurrences : 1;
  const oldBytes = Buffer.byteLength(options.oldText, "utf8");
  const newBytes = Buffer.byteLength(options.newText, "utf8");
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const unsafeProjection = newBytes > Math.floor(Number.MAX_SAFE_INTEGER / replacements);
  const projectedBytes = unsafeProjection
    ? Number.POSITIVE_INFINITY
    : before.bytes - oldBytes * replacements + newBytes * replacements;
  if (unsafeProjection || projectedBytes > maximum) {
    throw fileFailure(
      "FILE_TOO_LARGE",
      `Replacement result exceeds the ${maximum} byte write limit.`,
      {
        phase: "replacement_budget",
        path: options.path,
        projectedBytes,
        maxBytes: maximum,
        replacements,
      },
      ["Use a smaller replacement or split the change into bounded guarded edits."],
    );
  }
  const content = options.replaceAll
    ? before.content.replaceAll(options.oldText, options.newText)
    : before.content.replace(options.oldText, options.newText);
  const result = await writeProjectFile({
    ...options,
    content,
    guard: { mode: "match", sha256: before.sha256 },
  });
  return { ...result, replacements };
}
