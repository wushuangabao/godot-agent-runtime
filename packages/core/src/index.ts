export { defaultConfigPath, loadDevelopmentConfig } from "./config.js";
export { installGodotAddon } from "./addon.js";
export type { AddonInstallResult } from "./addon.js";
export { configureClient } from "./client-config.js";
export type {
  ClientConfigurationResult,
  ClientTarget,
  ConfigureClientOptions,
} from "./client-config.js";
export { findProjects } from "./discovery.js";
export type { FindProjectsOptions } from "./discovery.js";
export { runDoctor } from "./doctor.js";
export {
  classifyLogLine,
  getDiagnosticsSummary,
  readManagedLogs,
  shapeLogLines,
} from "./diagnostics.js";
export type {
  DiagnosticsOptions,
  LogSeverity,
  LogStream,
  ReadManagedLogsOptions,
  ShapeLogOptions,
  ShapedLogLine,
  ShapedLogLines,
} from "./diagnostics.js";
export {
  createDebugReport,
  redactDebugText,
  renderDebugReport,
} from "./debug-report.js";
export type { CreateDebugReportOptions } from "./debug-report.js";
export { RuntimeFailure, toRuntimeError } from "./errors.js";
export {
  batchEditorScene,
  captureEditorScreenshot,
  connectEditorSignal,
  createInheritedEditorScene,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  focusEditorResource,
  getEditorInstance,
  getEditorInfo,
  getEditorProjectSetting,
  getEditorNode,
  getEditorSceneTree,
  getEditorSelection,
  getEditorResource,
  inspectEditorResourcePath,
  launchEditor,
  instantiateEditorScene,
  moveEditorNode,
  openEditorScene,
  redoEditorAction,
  saveEditorScene,
  saveEditorResource,
  setEditorSelection,
  setEditorProjectSetting,
  setEditorInstanceEditable,
  undoEditorAction,
  updateEditorNode,
  updateEditorResource,
  upsertEditorInputAction,
} from "./editor.js";
export type {
  EditorBatchOptions,
  EditorInputActionUpsertOptions,
  EditorScreenshotOptions,
  EditorNodeCreateOptions,
  EditorNodeDeleteOptions,
  EditorNodeLookupOptions,
  EditorNodeMoveOptions,
  EditorNodeUpdateOptions,
  EditorProjectSettingGetOptions,
  EditorProjectSettingSetOptions,
  EditorMutationLookupOptions,
  EditorHistoryMutationOptions,
  EditorSceneOpenOptions,
  EditorSceneInstantiateOptions,
  EditorSceneInheritanceOptions,
  EditorResourceCreateOptions,
  EditorResourceLookupOptions,
  EditorResourceUpdateOptions,
  EditorResourceFocusOptions,
  EditorResourceSaveOptions,
  EditorResourceInspectOptions,
  EditorInstanceLookupOptions,
  EditorInstanceSetEditableOptions,
  EditorSelectionSetOptions,
  EditorSignalConnectOptions,
} from "./editor.js";
export {
  checkProject,
  launchProject,
  prepareHostEnvironment,
  resolveGodotExecutable,
  runProject,
} from "./godot.js";
export type { GodotOperationOptions } from "./godot.js";
export { getProjectContext } from "./project-context.js";
export type { ProjectContextOptions } from "./project-context.js";
export {
  getManagedRunStatus,
  getManagedRunConnection,
  launchManagedProcess,
  stopManagedRun,
} from "./managed-run.js";
export type {
  ManagedProcessLaunchOptions,
  ManagedRunLookupOptions,
  ManagedRunConnection,
} from "./managed-run.js";
export {
  assertProjectFingerprint,
  getProjectIdentity,
  getProjectSnapshot,
  inspectProject,
} from "./project.js";
export type { ProjectSnapshot } from "./project.js";
export { runProcess } from "./process.js";
export type { ProcessResult, RunProcessOptions } from "./process.js";
export { checkScript } from "./script-check.js";
export type { ScriptCheckOptions } from "./script-check.js";
export {
  readProjectFile,
  replaceProjectText,
  withProjectMutationLock,
  writeProjectFile,
} from "./safe-file.js";
export type {
  FileMutationGuard,
  ProjectMutationLease,
  ProjectMutationLockOptions,
  SafeFileOptions,
  SafeFileWriteOptions,
  SafeTextReplaceOptions,
} from "./safe-file.js";
export { ensureSafeProjectDirectory, resolveSafeTarget } from "./safe-path.js";
export type { SafeProjectTarget } from "./safe-path.js";
export {
  assertRuntime,
  captureRuntimeScreenshot,
  controlRuntime,
  findLoopbackPort,
  findRuntimeUi,
  getRuntimeNode,
  observeRuntime,
  projectRuntime3D,
  raycastRuntime3D,
  getRuntimeSceneTree,
  getRuntimeInfo,
  injectRuntimeInput,
  injectRuntimeInputSequence,
  sendBridgeCommand,
  simulateRuntimePhysics,
  waitForRuntimeBridge,
  waitForRuntime,
} from "./runtime.js";
export type {
  RuntimeAssertionOptions,
  RuntimeControlOptions,
  RuntimeInputOptions,
  RuntimeInputSequenceOptions,
  RuntimeInputStep,
  RuntimeLookupOptions,
  RuntimeNodeLookupOptions,
  RuntimeObservationOptions,
  RuntimeProjection3DOptions,
  RuntimeRaycast3DOptions,
  RuntimeSceneTreeOptions,
  RuntimeSimulationOptions,
  RuntimeUiFindOptions,
  RuntimeUiSelector,
  RuntimeWaitOptions,
} from "./runtime.js";
