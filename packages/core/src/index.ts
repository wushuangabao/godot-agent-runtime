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
export { RuntimeFailure, toRuntimeError } from "./errors.js";
export {
  captureEditorScreenshot,
  connectEditorSignal,
  createInheritedEditorScene,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  focusEditorResource,
  getEditorInstance,
  getEditorInfo,
  getEditorNode,
  getEditorSceneTree,
  getEditorSelection,
  getEditorResource,
  launchEditor,
  instantiateEditorScene,
  moveEditorNode,
  redoEditorAction,
  saveEditorScene,
  saveEditorResource,
  setEditorSelection,
  setEditorInstanceEditable,
  undoEditorAction,
  updateEditorNode,
  updateEditorResource,
} from "./editor.js";
export type {
  EditorScreenshotOptions,
  EditorNodeCreateOptions,
  EditorNodeDeleteOptions,
  EditorNodeLookupOptions,
  EditorNodeMoveOptions,
  EditorNodeUpdateOptions,
  EditorSceneInstantiateOptions,
  EditorSceneInheritanceOptions,
  EditorResourceCreateOptions,
  EditorResourceLookupOptions,
  EditorResourceUpdateOptions,
  EditorResourceFocusOptions,
  EditorResourceSaveOptions,
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
  inspectProject,
} from "./project.js";
export { runProcess } from "./process.js";
export type { ProcessResult, RunProcessOptions } from "./process.js";
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
