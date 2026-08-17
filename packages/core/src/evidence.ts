import {
  EvidenceMetadataSchema,
  type EvidenceMetadata,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { getProjectIdentity } from "./project.js";

export interface ScreenshotReceipt {
  readonly capturedAt: unknown;
  readonly scenePath: unknown;
}

interface EvidenceOptions {
  readonly projectPath: string;
  readonly runId: string;
  readonly receipt: ScreenshotReceipt;
}

function invalidReceipt(kind: "editor" | "runtime", receipt: ScreenshotReceipt): RuntimeFailure {
  return new RuntimeFailure({
    code: `${kind.toUpperCase()}_SCREENSHOT_RECEIPT_INVALID`,
    stage: "protocol",
    message: `${kind} bridge returned an invalid screenshot evidence receipt.`,
    details: {
      capturedAt: receipt.capturedAt ?? null,
      scenePath: receipt.scenePath ?? null,
    },
    recovery: ["Reinstall the Godot Agent Runtime addon and start a fresh managed run."],
  });
}

async function createEvidenceMetadata(
  kind: "editor" | "runtime",
  options: EvidenceOptions,
): Promise<EvidenceMetadata> {
  const identity = await getProjectIdentity(options.projectPath);
  const metadata = {
    class: kind === "editor" ? "editor_viewport" : "runtime_frame",
    capturedAt: options.receipt.capturedAt,
    projectFingerprint: identity.projectFingerprint,
    scenePath: options.receipt.scenePath,
    runId: options.runId,
    provesRuntime: kind === "runtime",
    provesInteraction: false,
    limitations: kind === "runtime"
      ? ["A single frame does not prove motion or input-driven behavior."]
      : [
          "An editor viewport does not prove that the game ran.",
          "A single frame does not prove motion or input-driven behavior.",
        ],
    warnings: options.receipt.scenePath === null
      ? ["No active scene was associated with this capture."]
      : [],
  };
  const parsed = EvidenceMetadataSchema.safeParse(metadata);
  if (!parsed.success) throw invalidReceipt(kind, options.receipt);
  return parsed.data;
}

export async function createEditorEvidenceMetadata(
  options: EvidenceOptions,
): Promise<Extract<EvidenceMetadata, { class: "editor_viewport" }>> {
  return await createEvidenceMetadata("editor", options) as Extract<
    EvidenceMetadata,
    { class: "editor_viewport" }
  >;
}

export async function createRuntimeEvidenceMetadata(
  options: EvidenceOptions,
): Promise<Extract<EvidenceMetadata, { class: "runtime_frame" }>> {
  return await createEvidenceMetadata("runtime", options) as Extract<
    EvidenceMetadata,
    { class: "runtime_frame" }
  >;
}
