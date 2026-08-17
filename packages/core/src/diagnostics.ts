import { open, stat } from "node:fs/promises";

import type {
  DiagnosticsSummary,
  LogCursor,
  LogEntry,
  LogReadResult,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { getManagedRunLogFiles, getManagedRunStatus } from "./managed-run.js";

const DEFAULT_MAX_LINES = 100;
const MAX_LINES = 500;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_BYTES = 1024 * 1024;
const SEVERITY_RANK = { info: 0, warning: 1, error: 2 } as const;
const NON_FATAL_ENGINE_DIAGNOSTICS = [
  /^ERROR: Failed to read the root certificate store\.$/,
  /^ERROR: Condition "p_format_loader\.is_null\(\)" is true\.$/,
];

export type LogSeverity = keyof typeof SEVERITY_RANK;
export type LogStream = "stdout" | "stderr" | "combined";

export interface ShapeLogOptions {
  readonly minimumSeverity?: LogSeverity;
  readonly contains?: string;
  readonly maxLines?: number;
  readonly deduplicate?: boolean;
  readonly raw?: boolean;
}

export interface ShapedLogLine {
  readonly severity: LogSeverity;
  readonly message: string;
  readonly count: number;
}

export interface ShapedLogLines {
  readonly entries: ShapedLogLine[];
  readonly hidden: {
    readonly belowSeverity: number;
    readonly contains: number;
    readonly duplicates: number;
  };
}

export interface ReadManagedLogsOptions extends ShapeLogOptions {
  readonly projectPath: string;
  readonly runId: string;
  readonly cursor?: LogCursor;
  readonly stream?: LogStream;
  readonly maxBytes?: number;
  readonly raw?: boolean;
}

export interface DiagnosticsOptions {
  readonly projectPath: string;
  readonly runId: string;
  readonly cursor?: LogCursor;
  readonly maxIssues?: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new RuntimeFailure({
      code: "LOG_OPTIONS_INVALID",
      stage: "validation",
      message: `${name} must be an integer from ${minimum} through ${maximum}.`,
      details: { [name]: selected, minimum, maximum },
      recovery: [`Pass ${name} within the documented bound.`],
    });
  }
  return selected;
}

export function classifyLogLine(message: string): LogSeverity {
  if (/^(?:SCRIPT ERROR|ERROR:)/i.test(message)) {
    return NON_FATAL_ENGINE_DIAGNOSTICS.some((pattern) => pattern.test(message))
      ? "warning"
      : "error";
  }
  if (/^(?:WARNING:|WARN(?:ING)?\b)/i.test(message)) return "warning";
  return "info";
}

export function shapeLogLines(
  lines: readonly string[],
  options: ShapeLogOptions = {},
): ShapedLogLines {
  const maxLines = boundedInteger(options.maxLines, DEFAULT_MAX_LINES, 1, MAX_LINES, "maxLines");
  const minimumSeverity = options.minimumSeverity ?? "info";
  const minimumRank = SEVERITY_RANK[minimumSeverity];
  const contains = options.contains;
  const entries: ShapedLogLine[] = [];
  const indexes = new Map<string, number>();
  const hidden = { belowSeverity: 0, contains: 0, duplicates: 0 };

  for (const source of lines.slice(0, maxLines)) {
    const withoutDelimiter = source.endsWith("\r") ? source.slice(0, -1) : source;
    const normalized = withoutDelimiter.trim();
    const message = options.raw ? withoutDelimiter : normalized;
    const severity = classifyLogLine(normalized);
    if (SEVERITY_RANK[severity] < minimumRank) {
      hidden.belowSeverity += 1;
      continue;
    }
    if (contains !== undefined && !message.includes(contains)) {
      hidden.contains += 1;
      continue;
    }
    if (options.deduplicate) {
      const key = `${severity}\0${message}`;
      const existing = indexes.get(key);
      if (existing !== undefined) {
        const entry = entries[existing];
        if (entry !== undefined) {
          entries[existing] = { ...entry, count: entry.count + 1 };
          hidden.duplicates += 1;
        }
        continue;
      }
      indexes.set(key, entries.length);
    }
    entries.push({ severity, message, count: 1 });
  }
  return { entries, hidden };
}

function completeUtf8Prefix(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let start = buffer.length - 1;
  while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1;
  if (start < 0) {
    throw new RuntimeFailure({
      code: "LOG_INVALID_UTF8",
      stage: "validation",
      message: "A managed run log contains invalid UTF-8.",
      recovery: ["Inspect the original log file with a binary-safe local tool."],
    });
  }
  const leading = buffer[start]!;
  const expectedLength = leading <= 0x7f
    ? 1
    : leading >= 0xc2 && leading <= 0xdf
      ? 2
      : leading >= 0xe0 && leading <= 0xef
        ? 3
        : leading >= 0xf0 && leading <= 0xf4
          ? 4
          : 0;
  const availableLength = buffer.length - start;
  const length = expectedLength > availableLength ? start : buffer.length;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    return length;
  } catch {
    throw new RuntimeFailure({
      code: "LOG_INVALID_UTF8",
      stage: "validation",
      message: "A managed run log contains invalid UTF-8.",
      recovery: ["Inspect the original log file with a binary-safe local tool."],
    });
  }
}

interface StreamRead {
  readonly lines: string[];
  readonly nextOffset: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
}

async function readStream(
  path: string,
  offset: number,
  maxBytes: number,
  maxLines: number,
): Promise<StreamRead> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    throw new RuntimeFailure({
      code: "RUN_LOG_UNAVAILABLE",
      stage: "discovery",
      message: "A managed run log file is unavailable.",
      details: { path, cause: error instanceof Error ? error.message : String(error) },
      recovery: ["Query the managed run again or launch a fresh run."],
    });
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > size) {
    throw new RuntimeFailure({
      code: "LOG_CURSOR_INVALID",
      stage: "validation",
      message: "The log cursor is outside the current log file.",
      details: { path, offset, size },
      recovery: ["Restart reading this run with a zero cursor."],
    });
  }
  if (maxBytes === 0 || offset === size || maxLines === 0) {
    return { lines: [], nextOffset: offset, bytesRead: 0, truncated: offset < size };
  }

  const requested = Math.min(maxBytes, size - offset);
  const buffer = Buffer.alloc(requested);
  const handle = await open(path, "r");
  let actual = 0;
  try {
    actual = (await handle.read(buffer, 0, requested, offset)).bytesRead;
  } finally {
    await handle.close();
  }
  const available = buffer.subarray(0, actual);
  let consumed = completeUtf8Prefix(available);

  let newlines = 0;
  for (let index = 0; index < consumed; index += 1) {
    if (available[index] !== 0x0a) continue;
    newlines += 1;
    if (newlines === maxLines && index + 1 < consumed) {
      consumed = index + 1;
      break;
    }
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(available.subarray(0, consumed));
  const lines = text.length === 0
    ? []
    : text.split("\n").filter((_, index, values) => index < values.length - 1 || values[index] !== "");
  return {
    lines,
    nextOffset: offset + consumed,
    bytesRead: consumed,
    truncated: offset + consumed < size,
  };
}

function emptyHidden() {
  return { belowSeverity: 0, contains: 0, duplicates: 0 };
}

export async function readManagedLogs(options: ReadManagedLogsOptions): Promise<LogReadResult> {
  const run = await getManagedRunLogFiles({
    projectPath: options.projectPath,
    runId: options.runId,
  });
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES, "maxBytes");
  const maxLines = boundedInteger(options.maxLines, DEFAULT_MAX_LINES, 1, MAX_LINES, "maxLines");
  const stream = options.stream ?? "combined";
  const cursor = options.cursor ?? { stdoutBytes: 0, stderrBytes: 0 };
  if (
    !Number.isInteger(cursor.stdoutBytes) || cursor.stdoutBytes < 0 ||
    !Number.isInteger(cursor.stderrBytes) || cursor.stderrBytes < 0
  ) {
    throw new RuntimeFailure({
      code: "LOG_CURSOR_INVALID",
      stage: "validation",
      message: "Log cursor offsets must be non-negative integers.",
      details: { cursor },
      recovery: ["Use nextCursor from a previous log result or restart from a zero cursor."],
    });
  }
  const selected = stream === "combined" ? ["stdout", "stderr"] as const : [stream] as const;
  let bytesRemaining = maxBytes;
  let linesRemaining = maxLines;
  let stdoutBytes = cursor.stdoutBytes;
  let stderrBytes = cursor.stderrBytes;
  let truncated = false;
  const hidden = emptyHidden();
  const entries: LogEntry[] = [];

  for (const current of selected) {
    const path = current === "stdout" ? run.stdoutPath : run.stderrPath;
    const offset = current === "stdout" ? stdoutBytes : stderrBytes;
    const read = await readStream(path, offset, bytesRemaining, linesRemaining);
    bytesRemaining -= read.bytesRead;
    linesRemaining -= read.lines.length;
    truncated ||= read.truncated;
    if (current === "stdout") stdoutBytes = read.nextOffset;
    else stderrBytes = read.nextOffset;
    const shaped = shapeLogLines(read.lines, {
      maxLines: Math.max(1, read.lines.length),
      ...(options.minimumSeverity === undefined ? {} : { minimumSeverity: options.minimumSeverity }),
      ...(options.contains === undefined ? {} : { contains: options.contains }),
      ...(options.deduplicate === undefined ? {} : { deduplicate: options.deduplicate }),
      raw: options.raw ?? false,
    });
    hidden.belowSeverity += shaped.hidden.belowSeverity;
    hidden.contains += shaped.hidden.contains;
    hidden.duplicates += shaped.hidden.duplicates;
    entries.push(...shaped.entries.map((entry) => ({ ...entry, stream: current })));
  }

  return {
    ok: true,
    projectPath: run.projectPath,
    runId: run.runId,
    stream,
    order: "stdout_then_stderr_blocks",
    cursor,
    nextCursor: { stdoutBytes, stderrBytes },
    entries,
    hidden,
    bytesRead: maxBytes - bytesRemaining,
    truncated,
    raw: options.raw ?? false,
  };
}

export async function getDiagnosticsSummary(
  options: DiagnosticsOptions,
): Promise<DiagnosticsSummary> {
  const maxIssues = boundedInteger(options.maxIssues, 50, 1, 50, "maxIssues");
  const status = await getManagedRunStatus({
    projectPath: options.projectPath,
    runId: options.runId,
    maxOutputBytes: 2,
  });
  const logs = await readManagedLogs({
    projectPath: status.projectPath,
    runId: status.runId,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    stream: "combined",
    minimumSeverity: "warning",
    maxLines: maxIssues,
    deduplicate: true,
  });
  const errors = logs.entries
    .filter(({ severity }) => severity === "error")
    .reduce((sum, { count }) => sum + count, 0);
  const warnings = logs.entries
    .filter(({ severity }) => severity === "warning")
    .reduce((sum, { count }) => sum + count, 0);
  const repeated = logs.entries.reduce((sum, { count }) => sum + count - 1, 0);
  const issues = logs.entries.slice(0, maxIssues);
  const nextActions: DiagnosticsSummary["nextActions"] = [];
  const parseError = logs.entries.find(({ severity, message }) =>
    severity === "error" && /(?:SCRIPT ERROR|PARSE(?:R)? ERROR)/i.test(message));
  if (parseError !== undefined) {
    nextActions.push({
      tool: /res:\/\/[^\s:]+\.gd/i.test(parseError.message)
        ? "godot_script_check"
        : "godot_project_check",
      reason: "An observed parser error requires a compile check at the narrowest available scope.",
      required: true,
    });
  }
  if (logs.truncated) {
    nextActions.push({
      tool: "godot_log_read",
      reason: "Observed logs were truncated; continue from nextCursor before treating diagnostics as complete.",
      required: true,
    });
  }
  if (status.state === "running" && errors === 0 && !logs.truncated) {
    nextActions.push({
      tool: "godot_runtime_assert",
      reason: "Clean diagnostics do not prove interaction; optionally assert the intended runtime state.",
      required: false,
    });
  }
  if (status.state === "running") {
    nextActions.push({
      tool: "godot_run_stop",
      reason: "The managed process is currently running and may be stopped when verification is complete.",
      required: false,
    });
  }
  return {
    ok: true,
    projectPath: status.projectPath,
    runId: status.runId,
    state: status.state,
    counts: { errors, warnings, unique: logs.entries.length, repeated },
    issues,
    nextCursor: logs.nextCursor,
    truncated: logs.truncated || logs.entries.length > maxIssues,
    nextActions,
  };
}
