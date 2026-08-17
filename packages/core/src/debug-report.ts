import { randomBytes } from "node:crypto";

import {
  EDITOR_PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  type DebugReportResult,
  type DiagnosticsSummary,
  type LogCursor,
  type LogEntry,
} from "@godot-agent-runtime/protocol";

import { getDiagnosticsSummary, readManagedLogs } from "./diagnostics.js";
import { runDoctor } from "./doctor.js";
import { assertProjectFingerprint } from "./project.js";
import { writeProjectFile } from "./safe-file.js";

const REPORT_CAPABILITIES = [
  "managed_logs",
  "structured_diagnostics",
  "redacted_debug_report",
] as const;

interface RenderDebugReportOptions {
  readonly format: "markdown" | "json";
  readonly issue: string;
  readonly reproduction?: string;
  readonly projectPath: string;
  readonly protocolVersions: { readonly editor: string; readonly runtime: string };
  readonly doctor: { readonly ok: boolean; readonly checks: readonly unknown[] };
  readonly diagnostics: Pick<DiagnosticsSummary, "counts" | "issues">;
  readonly logs: readonly LogEntry[];
  readonly runId: string | null;
  readonly capabilities: readonly string[];
  readonly engine?: string | null;
}

export interface CreateDebugReportOptions {
  readonly projectPath: string;
  readonly expectedProjectFingerprint: string;
  readonly issue: string;
  readonly runId?: string;
  readonly reproduction?: string;
  readonly cursor?: LogCursor;
  readonly format?: "markdown" | "json";
}

function truncateUtf8(source: string, maximum: number): string {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.length <= maximum) return source;
  let end = maximum;
  while (end > 0) {
    try {
      return `${new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))}\n[TRUNCATED]`;
    } catch {
      end -= 1;
    }
  }
  return "[TRUNCATED]";
}

export function redactDebugText(source: string): string {
  const redactAssignedValue = (_match: string, prefix: string, value: string): string => {
    if (value.startsWith("\"")) return `${prefix}\"[REDACTED]\"`;
    if (value.startsWith("'")) return `${prefix}'[REDACTED]'`;
    return `${prefix}[REDACTED]`;
  };
  return source
    .replace(
      /((?:["']\s*)?\bauthorization\b(?:\s*["'])?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|bearer\s+[^\s,;\]}]+)/gi,
      redactAssignedValue,
    )
    .replace(
      /((?:["']\s*)?\b(?:token|password|passwd|secret|api[_-]?key)\b(?:\s*["'])?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\]}]+)/gi,
      redactAssignedValue,
    );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactDebugText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /^(?:token|password|passwd|secret|api[_-]?key|authorization)$/i.test(key)
        ? "[REDACTED]"
        : redactValue(child),
    ]));
  }
  return value;
}

export function renderDebugReport(options: RenderDebugReportOptions): string {
  const boundedIssues = options.diagnostics.issues.slice(0, 50).map((issue) => ({
    ...issue,
    message: truncateUtf8(issue.message, 2048),
  }));
  const bounded = redactValue({
    projectPath: truncateUtf8(options.projectPath, 4096),
    runId: options.runId,
    issue: truncateUtf8(options.issue, 16 * 1024),
    ...(options.reproduction === undefined
      ? {}
      : { reproduction: truncateUtf8(options.reproduction, 32 * 1024) }),
    protocolVersions: options.protocolVersions,
    engine: options.engine ?? null,
    capabilities: options.capabilities.slice(0, 100),
    doctor: options.doctor,
    diagnostics: { counts: options.diagnostics.counts, issues: boundedIssues },
    logs: options.logs.slice(0, 200).map((entry) => ({
      ...entry,
      message: truncateUtf8(entry.message, 2048),
    })),
  }) as Record<string, unknown>;
  if (options.format === "json") return `${JSON.stringify(bounded, null, 2)}\n`;

  const lines = [
    "# Godot Agent Runtime Debug Report",
    "",
    "> Review this report before sharing it.",
    "",
  ];
  for (const [heading, value] of Object.entries(bounded)) {
    lines.push(`## ${heading}`, "", "```json", JSON.stringify(value, null, 2), "```", "");
  }
  return `${lines.join("\n")}\n`;
}

export async function createDebugReport(
  options: CreateDebugReportOptions,
): Promise<DebugReportResult> {
  const identity = await assertProjectFingerprint(
    options.projectPath,
    options.expectedProjectFingerprint,
  );
  const format = options.format ?? "markdown";
  const doctorResult = await runDoctor();
  const doctorChecks = doctorResult.checks.slice(0, 20).map(({ name, status, summary, recovery }) => ({
    name,
    status,
    summary: truncateUtf8(summary, 1024),
    ...(recovery === undefined ? {} : { recovery: recovery.slice(0, 5).map((item) => truncateUtf8(item, 1024)) }),
  }));
  let diagnostics: Pick<DiagnosticsSummary, "counts" | "issues"> = {
    counts: { errors: 0, warnings: 0, unique: 0, repeated: 0 },
    issues: [],
  };
  let logs: LogEntry[] = [];
  if (options.runId !== undefined) {
    const summary = await getDiagnosticsSummary({
      projectPath: identity.projectPath,
      runId: options.runId,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      maxIssues: 50,
    });
    diagnostics = { counts: summary.counts, issues: summary.issues };
    logs = (await readManagedLogs({
      projectPath: identity.projectPath,
      runId: options.runId,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      stream: "combined",
      minimumSeverity: "info",
      maxLines: 500,
      deduplicate: true,
    })).entries;
  }
  const engine = doctorChecks.find(({ name }) => name === "godot")?.summary ?? null;
  const content = renderDebugReport({
    format,
    issue: options.issue,
    ...(options.reproduction === undefined ? {} : { reproduction: options.reproduction }),
    projectPath: identity.projectPath,
    protocolVersions: {
      editor: EDITOR_PROTOCOL_VERSION,
      runtime: RUNTIME_PROTOCOL_VERSION,
    },
    doctor: { ok: doctorResult.ok, checks: doctorChecks },
    diagnostics,
    logs,
    runId: options.runId ?? null,
    capabilities: REPORT_CAPABILITIES,
    engine,
  });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `res://.godot/agent-runtime/reports/debug-${timestamp}-${randomBytes(6).toString("hex")}.${format === "json" ? "json" : "md"}`;
  const written = await writeProjectFile({
    projectPath: identity.projectPath,
    path,
    content,
    guard: { mode: "create" },
    expectedProjectFingerprint: identity.projectFingerprint,
    createDirectories: true,
  });
  const includedSections: DebugReportResult["includedSections"] = [
    "doctor",
    "protocolVersions",
    "engine",
    "capabilities",
    "diagnostics",
    "logs",
    "runId",
    "issue",
    ...(options.reproduction === undefined ? [] : ["reproduction"] as const),
  ];
  return {
    ok: true,
    projectPath: written.projectPath,
    path: written.path,
    bytes: written.bytes,
    sha256: written.sha256,
    includedSections,
    reviewRequired: true,
  };
}
