# Summer MCP-Inspired Godot MCP Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入定制 Godot、云服务、账号体系或任意代码执行入口的前提下，吸收 Summer Engine MCP 中适合本项目的安全默认值、批量编辑、上下文发现、诊断分流、证据语义和 Agent 引导设计。

**Architecture:** 保留现有 `TypeScript MCP/CLI -> Core -> loopback bridge -> 原版 Godot 4.x` 分层。新增能力仍先在 `packages/protocol` 定义稳定结果，再由 `packages/core` 提供唯一实现，MCP 与 CLI 只做参数校验和适配；EditorPlugin 只增加固定命令，不接受未知 raw op，也不提供任意 GDScript 探针。

**Tech Stack:** TypeScript 7、Node.js 20+、Zod 4、MCP SDK 2、Vitest 4、GDScript、Godot 4.x `EditorPlugin` / `EditorUndoRedoManager` / `ProjectSettings` / `InputMap`。

## Global Constraints

- 只支持原版 Godot 4.x 公共 API；不要求 Summer Engine 或任何定制 Godot 二进制。
- 不增加账号、计费、云同步、AI 资产生成、远程资产库或发布平台能力。
- Editor Bridge 与 Runtime Bridge 继续只监听 `127.0.0.1`，使用每次运行随机令牌和 `runId`，请求与响应上限保持 1 MiB。
- 不增加未知操作透传、通用脚本执行器、`run_script` 或 Summer 风格的 raw `RunVerification` 探针。
- 新批处理只接受版本化 tagged union；每批最多 32 个操作、一个明确场景和一次原生 Undo/Redo action。batch 不负责保存；保存必须在 batch 成功后通过受场景/历史前置条件保护的 `godot_editor_scene_save` 显式执行。
- 所有项目写入必须位于项目根目录内、拒绝符号链接/联接逃逸；Core 项目/run 路由权威层校验项目指纹，实际文件/Bridge 写入点再校验创建保护、内容 SHA-256、场景路径或历史版本中的适用前置条件。
- 现有 49 个工具名称和已有成功结果字段保持可用；新增字段采用 additive 方式。本轮有两类明确的 fail-closed 收紧：`godot_file_write` 缺少内容 guard 时拒绝，以及持久 Editor mutation/history 缺少 `expectedScenePath`（history 还缺少 `expectedHistoryVersion`）时拒绝。二者必须进入 `0.2` 迁移说明，不能描述成纯 additive 发布。
- 新 MCP 工具必须有 CLI 等价入口、严格 Zod `inputSchema` / `outputSchema`、结构化成功结果、稳定错误码和至少一条恢复建议。
- 诊断、截图和报告只返回有界内容；大日志和 PNG 继续返回项目内路径、大小和 SHA-256，不把二进制塞入模型上下文。
- 用户已明确授权在当前工作区实施本计划，不创建隔离 worktree。每个 Task 开始前必须检查并保护既有脏改动；各 Task 只提交自己的精确文件，不推送。
- 每个任务遵循 TDD：先写失败测试并确认预期失败，再做最小实现；每个任务完成后独立提交，执行阶段不得合并跳过验证。

---

## Scope Decisions

### 纳入实施

1. 显式项目上下文与项目指纹，不使用服务器全局隐式绑定。
2. 文件写入 fail-closed、唯一文本替换和并发冲突保护。
3. 单文件 GDScript 快速语法检查。
4. 活动场景前置条件、显式打开场景和目标场景回读。
5. 类型安全的编辑器批处理和单次 Undo/Redo。
6. 结构化项目设置、InputMap 写入和外部 Resource 检查。
7. 诊断摘要、日志游标/去重/过滤、脱敏调试报告和 MCP 调用诊断日志。
8. 截图证据分类、限制说明、项目/场景身份和时间戳。
9. MCP 内置 playbook、任务配方、结构化下一步建议和跨客户端基准。

### 明确排除

- Summer 的云同步、资产搜索、URL 下载、AI 图片/音频/视频/3D 生成和发布工具。
- Summer 的定制引擎接口、未知 raw op 透传和任意 GDScript 验证探针。
- 隐式修改非活动场景。标准 Godot 下先采用 `scene_open + expectedScenePath`；不偷偷切换并恢复编辑器标签。
- 合成相机的离屏场景预览。当前阶段只强化现有编辑器/运行时截图的证据语义；没有标准 API 与真实渲染证据前不新增 `scene_preview`。
- 在 MCP Core 内建设通用工作流引擎。Playbook 和 recipe 是只读静态指导，不持久化任务状态。

### 用现有或更安全机制替代的 Summer 工具

- 不增加 `clear_console`：每个受管运行已有独立日志文件，Task 7 的 byte cursor 能提供无破坏的“从这里开始看”语义，保留用户原始日志。
- 不增加专用 `replace_node`：Task 5 用一个 typed batch 组合 instantiate/move/delete，并以一次 Undo/Redo 保证原子回退。
- 不重复增加 `inspect_node`、`set_resource_property`、`save_scene`、`select_node`：本项目已有 `godot_editor_node_get`、Resource get/update、scene save 和 selection 工具。
- 不增加 URL/在线资产导入：这会把本地固定边界扩大为 open-world 网络能力；以后若有明确需求，应作为独立、需确认且带许可证元数据的设计评审。

### Summer 能力审计闭包与决策矩阵

审计基线由两部分组成：Summer Engine Agent 公开仓库/文档，以及 2026-08-17 本机 Summer skills 中实际引用的 `summer_*` 工具名。Task 1 必须把公开仓库固定到具体 commit/tag，生成机器可读 inventory 与 decision manifest，再由测试计算集合闭包；下面的 Markdown 表仅是人类可读投影，不作为集合真源。若上游新增能力，必须先新增 inventory item 并作出决策，不能默认遗漏。每个已知能力恰好归入“采用、适配、已有、拒绝、延期”之一。只研究公开行为和接口思想，不复制未核验许可证的实现代码。

| Summer 能力/公开工具 | 本项目现状 | 决策 | 理由与落实位置 |
|---|---|---|---|
| `summer_get_project_context` | 缺少聚合入口 | 采用 | 显式项目身份、Editor/Runtime 上下文；Tasks 1、3 |
| `summer_write_file`、`summer_replace_text` | 已有安全读写但 guard 可省略，无唯一替换 | 适配 | fail-closed guard、项目指纹、唯一替换和写入锁；Task 2 |
| `summer_get_script_errors` | 已有项目级 check，无轻量单文件检查 | 适配 | 原版 Godot `--script --check-only`；Task 3 |
| `summer_create_scene`、`summer_open_scene`、`summer_save_scene` | 已有保存，缺少显式打开和活动场景 guard | 适配 | 保留固定命令，增加显式 open 与 guarded save；Task 4 |
| `summer_get_scene_tree`、`summer_inspect_node` | 已有结构化场景树/节点读取 | 已有 | 不新增同义工具；只补项目/场景身份前置条件；Task 4 |
| `summer_add_node`、`summer_set_prop`、`summer_instantiate_scene`、`summer_connect_signal`、节点移动/删除/选择、Undo/Redo | 已有原子操作 | 适配 | 旧工具保留；mutation/history 加场景与历史 guard；Task 4 |
| `summer_set_resource_property`、`summer_inspect_resource` | 已有内嵌 Resource 编辑，缺外部 Resource 摘要 | 适配 | 复用 tagged Variant，增加项目内 `.tres/.res` 只读检查；Task 6 |
| `summer_batch`、`summer_replace_node` | 缺少一 action 的 typed batch | 适配 | 版本化 strict union；替换节点由组合操作表达，不增加专用同义工具；Task 5 |
| `summer_project_setting`、`summer_input_map_bind` | 缺少结构化配置写入 | 适配 | 有界 Variant、实际权威点 CAS、专用 InputMap union；Task 6 |
| `summer_get_console`、`summer_get_debugger_errors`、`summer_get_diagnostics`、`summer_create_debug_report` | 有受管日志，缺游标/漏斗/报告 | 适配 | 不破坏原日志，增加有界读取、摘要和脱敏报告；Task 7 |
| `summer_clear_console` | 受管运行已有独立日志 | 拒绝 | byte cursor 提供非破坏起点，避免删除证据；Task 7 |
| `summer_play`、`summer_stop`、`summer_is_running` | 已有受管启动/状态/停止 | 已有 | 不新增同义工具；Task 9 只编排真实验收 |
| Summer 运行时输入、视口截图和验证循环 | 已有 input/find/wait/assert/observe/simulate/control | 已有并强化 | 保留本项目结构化运行时优势；Task 8 增加截图证据语义，Task 9 验收 |
| 合成 `scene_preview` / 离屏预览 | 无可信标准 Godot 实现 | 延期 | 在原版 API 能证明真实渲染前不实现；Task 8 仅分类真实捕获 |
| raw op、`RunVerification`、任意 GDScript 探针 | 明确不做 | 拒绝 | 固定命令 + typed schema + 结构化 assert，不扩大为任意执行 |
| Summer skills 路由、playbook、recipe | MCP instructions 较薄 | 适配 | 规范数据放 Core，以一个可发现工具服务 tool-only 客户端；Task 9A |
| `summer_search_assets`、`summer_list_my_assets`、`summer_get_asset`、`summer_get_asset_download_url`、`summer_import_asset_by_id`、`summer_import_from_url` | 核心本地优先，无资产后端 | 拒绝 | 涉及账号、网络、许可证和远端状态；保持核心边界 |
| `summer_generate_image`、`summer_generate_audio`、`summer_generate_voice`、`summer_generate_video`、`summer_generate_3d`、`summer_generate_motion`、`summer_list_models`、`summer_check_job` | 不提供生成服务 | 拒绝 | 不引入模型服务、密钥、计费或异步云任务 |
| `summer_cloud_init/status/push/pull/conflicts/checkpoints/restore` | 不提供云同步 | 拒绝 | 项目级恢复交给 Git，本地优先 |
| Summer 导出/部署技能中的平台发布行为 | 现阶段不在 MCP 闭环范围 | 延期 | 另立带签名、凭据、设备与发布确认的高风险设计，不混入本轮 |

审计完成条件：冻结的 Summer 工具集合减去矩阵覆盖集合必须为空；矩阵中“采用/适配”每项必须指向至少一个 Task 和测试，“已有”必须指向现有工具/测试，“拒绝/延期”必须保留边界理由与许可证判断。Task 9C 将冻结来源、commit/tag、差异和最终决策同步到 `docs/comparisons.md`。

## File Map

| 文件 | 责任 |
|---|---|
| `packages/protocol/src/index.ts` | 项目身份、批处理、诊断、证据、指导结果的唯一 Zod/TypeScript 契约 |
| `packages/core/src/project.ts` | 规范化项目路径、项目文件读取和项目指纹 |
| `packages/core/src/project-context.ts` | 聚合项目、Editor、Runtime 上下文 |
| `packages/core/src/safe-path.ts` | 项目内真实路径/资源路径解析、链接逃逸拒绝的共享实现 |
| `packages/core/src/safe-file.ts` | fail-closed 原子写和唯一文本替换 |
| `packages/core/src/script-check.ts` | `godot --script --check-only` 单文件检查 |
| `packages/core/src/editor.ts` | Editor Bridge 的类型安全调用适配 |
| `packages/core/src/diagnostics.ts` | 日志读取、游标、过滤、去重和诊断摘要 |
| `packages/core/src/debug-report.ts` | 脱敏 Markdown/JSON 调试报告 |
| `packages/core/src/evidence.ts` | 截图证据元数据和限制说明 |
| `packages/core/src/agent-guidance.ts` | playbook/recipe 的规范化共享数据与查询 API |
| `packages/core/src/index.ts` | 导出新增 Core API |
| `addons/godot_agent_runtime/editor_bridge.gd` | 固定的场景、批处理、项目设置、InputMap、Resource 命令 |
| `packages/mcp-server/src/server.ts` | 新工具 Schema、注册、调用日志和 Core 适配 |
| `packages/cli/src/bin.ts` | 新能力的 CLI 等价入口 |
| `tests/unit/*.test.ts` | 项目身份、文件保护、日志整形、证据和指导的快速测试 |
| `tests/integration/*.test.ts` | MCP Schema、真实 Godot、EditorPlugin 和调试报告集成测试 |
| `tests/agent-benchmarks/milestone-5/run.mjs` | 优化后完整闭环的统一真实 Godot 验收 |
| `docs/*.md`、`README.md`、`adapters/agent-recipes.md` | 契约、边界、迁移和 Agent 使用说明 |

---

### Task 1: Summer 能力清单、项目身份与协议基础

**Files:**
- Create: `docs/research/summer-mcp-inventory.json`
- Create: `docs/research/summer-mcp-decisions.json`
- Create: `tests/fixtures/mcp-tool-baseline-0.1.json`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/project.ts`
- Modify: `packages/core/src/index.ts`
- Create: `tests/unit/summer-capability-matrix.test.ts`
- Create: `tests/unit/project-identity.test.ts`

**Interfaces:**
- Produces: `ProjectIdentitySchema` / `ProjectIdentity`
- Produces: `getProjectIdentity(projectPath: string): Promise<ProjectIdentity>`
- Produces: `assertProjectFingerprint(projectPath: string, expected?: string): Promise<ProjectIdentity>`
- `ProjectIdentity` fields: `projectPath`, `projectFile`, `projectFingerprint`, `projectFileSha256`
- Later tasks consume `projectFingerprint` as wrong-project protection and `projectFileSha256` as `project.godot` write precondition.

- [ ] **Step 0: 冻结 Summer 来源并写集合闭包测试**

`summer-mcp-inventory.json` 固定 `reviewedAt`、公开来源 URL、commit/tag、许可证标识，并列出精确 item：所有发现的 `summer_*` 工具使用 `tool:<exact-name>` id，非工具行为（例如 runtime input/verification loop、skills routing、合成 scene preview）使用稳定 `behavior:<name>` id。不得只写“运行时输入等”这种不可比较分组。

`summer-mcp-decisions.json` 为每个 inventory id 提供且只提供一条 `{ id, decision, rationale, tasks, existingEvidence? }`；`decision` 只能是 `adopt|adapt|existing|reject|defer`。Task 1 测试只读取两个 JSON，验证来源 commit/tag 非空、id 无重复、集合完全相等、adopt/adapt 有 Task、existing 有现有文件/测试证据、reject/defer 有边界理由，并把未分类/重复项直接打印为失败差集。`docs/comparisons.md` 的人类可读投影到 Task 9C 才更新并增加投影总数断言，不能反向成为真源。

同时从本计划基线 commit `657701a2ff26d569017a12465298a9f7d41a3f48` 的真实 MCP `list_tools` 冻结 `tests/fixtures/mcp-tool-baseline-0.1.json`：记录 commit、序列化算法（稳定 UTF-8 JSON，键排序规则固定）、`toolCount:49`、精确 `toolSchemaBytes` 和 `instructionsBytes`。单测从该 commit/fixture 校验一次，不允许 Task 9 重新计算或修改 baseline；Task 9 只能拿最终值与它比较。

Run: `pnpm exec vitest run tests/unit/summer-capability-matrix.test.ts`

Expected: 首次 FAIL，直到冻结 inventory 与每项 decision 完整；完成后未分类、额外、重复均为 0。网络只用于这次设计时冻结，不成为运行时依赖。

- [ ] **Step 1: 写项目指纹失败测试**

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { getProjectIdentity } from "../../packages/core/src/project.js";

it("returns a stable path identity and a content receipt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-identity-"));
  await writeFile(resolve(root, "project.godot"), "config_version=5\n", "utf8");
  const first = await getProjectIdentity(root);
  const second = await getProjectIdentity(root);
  expect(first.projectFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(first.projectFingerprint).toBe(second.projectFingerprint);
  expect(first.projectFileSha256).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 运行测试并确认缺少 API**

Run: `pnpm exec vitest run tests/unit/summer-capability-matrix.test.ts tests/unit/project-identity.test.ts`

Expected: FAIL，TypeScript/Vitest 指出 `getProjectIdentity` 未导出。

- [ ] **Step 3: 增加协议与 Core 实现**

在 `packages/protocol/src/index.ts` 增加：

```ts
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ProjectIdentitySchema = z.object({
  projectPath: z.string().min(1),
  projectFile: z.string().min(1),
  projectFingerprint: Sha256Schema,
  projectFileSha256: Sha256Schema,
});

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;
```

在 `packages/core/src/project.ts` 使用 `realpath()` 获得真实项目根；Windows 下仅对用于哈希的路径转小写，返回路径仍保留系统规范形式：

```ts
export async function getProjectIdentity(projectPath: string): Promise<ProjectIdentity> {
  const project = await inspectProject(projectPath);
  const canonicalPath = await realpath(project.projectPath);
  const projectFile = resolve(canonicalPath, "project.godot");
  const bytes = await readFile(projectFile);
  const identityPath = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return {
    projectPath: canonicalPath,
    projectFile,
    projectFingerprint: createHash("sha256").update(identityPath, "utf8").digest("hex"),
    projectFileSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function assertProjectFingerprint(
  projectPath: string,
  expected?: string,
): Promise<ProjectIdentity> {
  const identity = await getProjectIdentity(projectPath);
  if (expected !== undefined && expected !== identity.projectFingerprint) {
    throw new RuntimeFailure({
      code: "PROJECT_IDENTITY_MISMATCH",
      stage: "validation",
      message: "The requested project does not match the previously inspected project.",
      details: { expected, actual: identity.projectFingerprint, projectPath: identity.projectPath },
      recovery: ["Call godot_project_context for the intended project and retry with its projectFingerprint."],
    });
  }
  return identity;
}
```

- [ ] **Step 4: 增加错项目测试并运行**

追加断言：错误指纹抛出 `PROJECT_IDENTITY_MISMATCH`，正确指纹通过。运行：

Run: `pnpm exec vitest run tests/unit/summer-capability-matrix.test.ts tests/unit/project-identity.test.ts`

Expected: PASS；项目身份 2 tests，Summer inventory/decision 未分类、额外、重复均为 0。

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm run typecheck`

Expected: exit 0。

```powershell
git add docs/research/summer-mcp-inventory.json docs/research/summer-mcp-decisions.json tests/fixtures/mcp-tool-baseline-0.1.json packages/protocol/src/index.ts packages/core/src/project.ts packages/core/src/index.ts tests/unit/summer-capability-matrix.test.ts tests/unit/project-identity.test.ts
git commit -m "feat: freeze Summer decisions and add project identity"
```

---

### Task 2: Fail-Closed 文件写入与唯一文本替换

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/core/src/safe-path.ts`
- Modify: `packages/core/src/safe-file.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `tests/unit/safe-file.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`

**Interfaces:**
- Produces: `FileMutationGuard = { mode: "create" } | { mode: "match"; sha256: string }`
- Produces: `replaceProjectText(options: SafeTextReplaceOptions): Promise<SafeFileWriteResult & { replacements: number }>`
- `godot_file_write` accepts exactly one of `guard` or legacy `expectedSha256`; neither is rejected.
- `godot_file_write` accepts optional `expectedProjectFingerprint`; new `godot_file_replace` requires it.
- Produces: `withProjectMutationLock()` and shared project-internal path resolution used by later mutation tasks.
- Produces MCP/CLI entry: `godot_file_replace` / `file-replace`.

- [ ] **Step 1: 写无保护写入、唯一替换和歧义替换失败测试**

```ts
await expect(writeProjectFile({
  projectPath,
  path: "main.gd",
  content: "extends Node2D\n",
})).rejects.toMatchObject({ payload: { code: "FILE_GUARD_REQUIRED" } });

const replaced = await replaceProjectText({
  projectPath,
  expectedProjectFingerprint: identity.projectFingerprint,
  path: "main.gd",
  oldText: "extends Node",
  newText: "extends Node2D",
});
expect(replaced.replacements).toBe(1);

await writeFile(resolve(projectPath, "duplicate.gd"), "value = 1\nvalue = 1\n", "utf8");
await expect(replaceProjectText({
  projectPath,
  expectedProjectFingerprint: identity.projectFingerprint,
  path: "duplicate.gd",
  oldText: "value = 1",
  newText: "value = 2",
})).rejects.toMatchObject({ payload: { code: "FILE_REPLACE_AMBIGUOUS" } });
```

- [ ] **Step 2: 运行现有文件测试并确认新断言失败**

Run: `pnpm exec vitest run tests/unit/safe-file.test.ts`

Expected: FAIL，首个失败为无保护写入未被拒绝或 `replaceProjectText` 不存在。

- [ ] **Step 3: 实现显式 guard 与兼容映射**

```ts
export type FileMutationGuard =
  | { readonly mode: "create" }
  | { readonly mode: "match"; readonly sha256: string };

function expectedReceipt(options: SafeFileWriteOptions): string | null {
  if (options.guard !== undefined && options.expectedSha256 !== undefined) {
    throw fileFailure("FILE_GUARD_CONFLICT", "Provide guard or expectedSha256, not both.");
  }
  if (options.guard?.mode === "create") return null;
  if (options.guard?.mode === "match") return options.guard.sha256;
  if (options.expectedSha256 !== undefined) return options.expectedSha256;
  throw fileFailure("FILE_GUARD_REQUIRED", "A create or SHA-256 match guard is required.");
}
```

继续接受 `expectedSha256: null|string`，保证遵循旧文档的安全调用可用；只拒绝过去未携带任何保护的覆盖。

- [ ] **Step 4: 抽取安全路径并实现可说明边界的写入锁/CAS**

把 `resolveSafeTarget` 从 `safe-file.ts` 抽到 `safe-path.ts`，供 script check、Resource、evidence/report 复用；所有调用仍以 canonical project root 为边界并拒绝链接/联接逃逸。

所有文件 mutation 先调用 `assertProjectFingerprint`，再进入以 canonical project path + resource path 为键的项目内排他 lease（锁文件放在 `res://.godot/agent-runtime/locks/`，使用 exclusive create、owner nonce、owner PID、heartbeat、过期时间和有界等待）。活动 owner 每 5 秒续租；竞争者只有在 owner 进程不可存活且 heartbeat 超时后才可回收，不能仅凭墙钟 TTL 删除活跃 lease。默认 TTL 必须大于任何使用者的最大写操作期限及安全余量。锁内必须重新读取目标并重验 guard，不能只依赖锁外检查：

- `mode:"match"`：锁内 SHA-256 不匹配即 `FILE_WRITE_CONFLICT`，临时文件 flush 后才发布。
- `mode:"create"`：使用平台支持的 no-replace/exclusive publish；竞争中新建目标时返回 `FILE_ALREADY_EXISTS`，绝不能用普通 replace-rename 覆盖。
- 已知成功/已知未写入的失败在 `finally` 中只释放 owner nonce 匹配的 lease；“远端写入结果未知”不能走普通释放，必须由调用方进入状态调和或把 lease 标记为带 `quarantineUntil` 的未知结果。崩溃遗留只有在 owner 不存活且超过覆盖最大操作期限的 quarantine/TTL 后才能回收。

这个 lease 只协调遵循本协议的多个 MCP/CLI 进程；Godot 编辑器或第三方进程不遵循 lease，因此内容 SHA-256 仍是外部并发保护，且文档必须明确普通“检查后 rename”不是通用跨进程事务。增加两个独立 Node 子进程争用同一路径的集成测试，证明同一 guard 只有一个成功；另测试活跃 heartbeat 不会被 TTL 误回收、owner 崩溃后只能在安全期限后回收。

- [ ] **Step 5: 实现服务器内读改写**

```ts
export async function replaceProjectText(
  options: SafeTextReplaceOptions,
): Promise<SafeFileWriteResult & { replacements: number }> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  const before = await readProjectFile(options);
  const occurrences = before.content.split(options.oldText).length - 1;
  if (occurrences === 0) throw fileFailure("FILE_REPLACE_NOT_FOUND", "oldText was not found.");
  if (!options.replaceAll && occurrences !== 1) {
    throw fileFailure("FILE_REPLACE_AMBIGUOUS", "oldText must match exactly once unless replaceAll is true.");
  }
  const content = options.replaceAll
    ? before.content.split(options.oldText).join(options.newText)
    : before.content.replace(options.oldText, options.newText);
  const result = await writeProjectFile({
    ...options,
    content,
    guard: { mode: "match", sha256: before.sha256 },
  });
  return { ...result, replacements: options.replaceAll ? occurrences : 1 };
}
```

- [ ] **Step 6: 注册 MCP Schema 和 CLI**

MCP `FileWriteInputSchema` 使用 `superRefine` 保证 `guard`/`expectedSha256` 恰有一个；新增：

```ts
const FileReplaceInputSchema = FileReadInputSchema.extend({
  expectedProjectFingerprint: Sha256Schema,
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
}).strict();
```

CLI 增加：

```text
file-read PROJECT_PATH RES_PATH
file-write PROJECT_PATH RES_PATH --content TEXT (--create-only | --expected-sha256 HASH) [--expected-project-fingerprint HASH]
file-replace PROJECT_PATH RES_PATH --project-fingerprint HASH --old TEXT --new TEXT [--replace-all true|false]
```

- [ ] **Step 7: 验证 Core、MCP Schema 与旧安全参数兼容**

Run: `pnpm exec vitest run tests/unit/safe-file.test.ts tests/integration/mcp-server.test.ts`

Expected: PASS；`godot_file_replace` 出现在工具清单；旧的 `expectedSha256` 安全调用仍成功；无 guard 调用返回 `FILE_GUARD_REQUIRED`；错项目指纹零修改；exclusive create 与两个子进程的相同 CAS 竞争均只有一个成功。

- [ ] **Step 8: 提交**

```powershell
git add packages/protocol/src/index.ts packages/core/src/safe-path.ts packages/core/src/safe-file.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts tests/unit/safe-file.test.ts tests/integration/mcp-server.test.ts
git commit -m "feat: require guarded file mutations"
```

---

### Task 3: 项目上下文与单文件脚本检查

**Files:**
- Create: `packages/core/src/project-context.ts`
- Create: `packages/core/src/script-check.ts`
- Modify: `packages/core/src/godot.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Create: `tests/unit/project-context.test.ts`
- Create: `tests/fixtures/script-check/project.godot`
- Create: `tests/fixtures/script-check/valid.gd`
- Create: `tests/fixtures/script-check/invalid.gd`
- Modify: `tests/integration/godot-headless.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`

**Interfaces:**
- Produces: `getProjectContext({ projectPath, editorRunId?, runtimeRunId? }): Promise<ProjectContext>`
- Produces: `checkScript({ projectPath, path, configPath?, timeoutMs?, maxOutputBytes? }): Promise<ScriptCheckResult>`
- Produces MCP/CLI: `godot_project_context` / `context`, `godot_script_check` / `script-check`.
- Godot CLI behavior is based on the official `--script <path> --check-only` contract.

- [ ] **Step 1: 写项目上下文失败测试**

```ts
const context = await getProjectContext({ projectPath: resolve("examples/minimal-2d") });
expect(context).toMatchObject({
  ok: true,
  project: { mainScene: "res://main.tscn" },
  editor: null,
  runtime: null,
});
expect(context.identity.projectFingerprint).toMatch(/^[0-9a-f]{64}$/);
```

- [ ] **Step 2: 写脚本检查真实 Godot 失败测试**

```ts
const valid = await checkScript({ projectPath: fixture, path: "res://valid.gd", configPath });
expect(valid.ok).toBe(true);
const invalid = await checkScript({ projectPath: fixture, path: "res://invalid.gd", configPath });
expect(invalid.ok).toBe(false);
expect(invalid.diagnostics.some((item) => item.severity === "error")).toBe(true);
```

`valid.gd` 内容为 `extends Node\n`；`invalid.gd` 内容为 `extends Node\nfunc broken(:\n`。

- [ ] **Step 3: 运行目标测试并确认 API 不存在**

Run: `pnpm exec vitest run tests/unit/project-context.test.ts tests/integration/godot-headless.test.ts`

Expected: FAIL，缺少 `getProjectContext` / `checkScript`。

- [ ] **Step 4: 实现无隐式绑定的上下文聚合**

```ts
export interface ProjectContextOptions {
  readonly projectPath: string;
  readonly editorRunId?: string;
  readonly runtimeRunId?: string;
}

export async function getProjectContext(options: ProjectContextOptions): Promise<ProjectContext> {
  const [project, identity] = await Promise.all([
    inspectProject(options.projectPath),
    getProjectIdentity(options.projectPath),
  ]);
  const editor = options.editorRunId === undefined
    ? null
    : await getEditorInfo({ projectPath: identity.projectPath, runId: options.editorRunId });
  const runtime = options.runtimeRunId === undefined
    ? null
    : await getRuntimeInfo({ projectPath: identity.projectPath, runId: options.runtimeRunId });
  return { ok: true, project, identity, editor, runtime };
}
```

传入的 runId 不存在、属于其他项目或协议不兼容时必须返回原有结构化错误，不把失败吞成 `null`。

- [ ] **Step 5: 实现 `--check-only`**

使用 Task 2 抽出的 `safe-path.ts` 确认 `.gd` 位于项目内且不是链接；复用 `prepareHostEnvironment()` 隔离 `GODOT_USER_DATA_DIR`、配置和缓存，不触碰用户全局 Godot 目录，再执行：

```ts
const result = await runProcess(executable, [
  "--headless",
  "--no-header",
  "--path", project.projectPath,
  "--script", normalizedResourcePath,
  "--check-only",
], { timeoutMs, maxOutputBytes, env: await prepareHostEnvironment(project.projectPath) });
```

结果包含 `ok`、`path`、`exitCode`、`timedOut`、`durationMs`、`stdout`、`stderr`、`truncated`、`diagnostics`。非 `.gd` 返回 `SCRIPT_TYPE_UNSUPPORTED`；C# 继续使用 `godot_project_check`。

- [ ] **Step 6: 注册 MCP/CLI 并补 Schema 语义测试**

`godot_project_context` 标注 `readOnlyHint:true, idempotentHint:true`；`godot_script_check` 虽不改源文件但会写隔离的 `.godot`/缓存，因此标注 `readOnlyHint:false, idempotentHint:true`，与 `godot_project_check` 一致。MCP 集成测试必须检查两个工具存在、有 `outputSchema` 且 annotation 精确匹配；headless 测试证明用户全局 Godot 配置目录没有被访问。

- [ ] **Step 7: 运行验证并提交**

Run: `pnpm exec vitest run tests/unit/project-context.test.ts tests/integration/godot-headless.test.ts tests/integration/mcp-server.test.ts`

Expected: PASS，0 failures。

```powershell
git add packages/core/src/project-context.ts packages/core/src/script-check.ts packages/core/src/godot.ts packages/protocol/src/index.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts tests/unit/project-context.test.ts tests/fixtures/script-check/project.godot tests/fixtures/script-check/valid.gd tests/fixtures/script-check/invalid.gd tests/integration/godot-headless.test.ts tests/integration/mcp-server.test.ts
git commit -m "feat: add project context and script checks"
```

---

### Task 4: 活动场景前置条件与显式打开场景

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/editor.ts`
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/doctor.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `addons/godot_agent_runtime/editor_bridge.gd`
- Modify: `tests/integration/editor-plugin.test.ts`
- Modify: `tests/integration/runtime-bridge.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Modify: `tests/unit/addon.test.ts`
- Modify: `tests/unit/bridge-handshake.test.ts`
- Create: `tests/unit/protocol-versions.test.ts`
- Create: `docs/migrations/0.2.md`

**Interfaces:**
- Produces: `openEditorScene({ projectPath, runId, expectedProjectFingerprint, scenePath }): Promise<EditorSceneOpenResult>`
- Adds optional `expectedProjectFingerprint` to existing mutation tools.
- Adds required `expectedScenePath` to persistent active-scene mutations, scene save, undo and redo.
- Adds `historyVersion` to mutation results; scene save/undo/redo additionally require `expectedHistoryVersion`.
- Adds `historyVersion: number|null` to Editor hello/status so a first-time caller can obtain the guard before any mutation.
- Splits bridge transport versions into `EDITOR_PROTOCOL_VERSION` and `RUNTIME_PROTOCOL_VERSION` so Editor-only evolution cannot invalidate Runtime.
- Produces MCP/CLI: `godot_editor_scene_open` / `editor-scene-open`.

- [ ] **Step 1: 写场景不匹配零修改测试**

```ts
await expect(createEditorNode({
  projectPath,
  runId,
  expectedScenePath: "res://not-open.tscn",
  parentPath: "/root/Main",
  type: "Label",
  name: "WrongSceneProbe",
  properties: {},
})).rejects.toMatchObject({ payload: { code: "EDITOR_SCENE_MISMATCH" } });

await expect(getEditorNode({
  projectPath,
  runId,
  nodePath: "/root/Main/WrongSceneProbe",
})).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
```

- [ ] **Step 2: 写显式打开场景测试**

```ts
const opened = await openEditorScene({
  projectPath,
  runId,
  expectedProjectFingerprint: identity.projectFingerprint,
  scenePath: "res://badge.tscn",
});
expect(opened).toMatchObject({
  opened: true,
  previousScene: "res://main.tscn",
  scene: "res://badge.tscn",
});
```

再写 history 竞态测试：先在 `main.tscn` 创建一个 action 并记录 `historyVersion`，切换到 `badge.tscn` 后，用旧 `expectedScenePath/historyVersion` 调用 undo/redo/save，必须分别返回 `EDITOR_SCENE_MISMATCH` 且两个场景均零修改；在同一场景插入另一个用户 action 后，用 stale version 调用则返回 `EDITOR_HISTORY_CONFLICT`。

补 status 获取测试：首次连接已有活动场景时 `godot_editor_status` / `getEditorInfo` 返回当前非负 `historyVersion`；用户在 Godot 中插入 action 后再次 status 得到新 version；无活动场景返回 `historyVersion:null`。MCP output Schema 与 CLI `editor-status` 原样暴露这个 additive 字段。

- [ ] **Step 3: 运行 EditorPlugin 测试并确认失败**

Run: `pnpm exec vitest run tests/integration/editor-plugin.test.ts`

Expected: FAIL，缺少 `openEditorScene` 或错误场景未被拒绝。

- [ ] **Step 4: 在桥接层集中校验场景**

```gdscript
func _require_edited_scene(params: Dictionary) -> Dictionary:
	var root := _editor.get_edited_scene_root()
	if root == null:
		return _failure("EDITOR_SCENE_NOT_OPEN", "No edited scene is open.")
	var expected := str(params.get("expectedScenePath", ""))
	if expected.is_empty():
		return _failure("EDITOR_SCENE_PATH_REQUIRED", "expectedScenePath is required for scene mutations.")
	if root.scene_file_path != expected:
		return _failure("EDITOR_SCENE_MISMATCH", "The active scene does not match expectedScenePath.", {
			"expectedScenePath": expected,
			"actualScenePath": root.scene_file_path,
		})
	return {"ok": true, "root": root}
```

所有节点、Resource、实例可编辑、信号、保存、undo/redo 和后续 batch 命令在读取/创建 Undo action 前调用此函数。每个成功 mutation 返回其目标 scene history 的 `historyVersion`；`scene_save`、`history_undo`、`history_redo` 在执行前同时比较 `expectedHistoryVersion`，不匹配时返回 `EDITOR_HISTORY_CONFLICT`。history 命令还可接受 `expectedActionName` 作更强的可选校验，但不能用名称代替 version。

- [ ] **Step 5: 增加固定 `scene_open` 命令**

`scene_open` 要求 `expectedProjectFingerprint`，只接受项目内 `.tscn`，调用 `EditorInterface.open_scene_from_path()`，等待编辑根路径匹配，超时返回 `EDITOR_SCENE_OPEN_TIMEOUT`；不自动恢复旧标签，不标记为可撤销。结果返回新场景 `historyVersion`，供后续 guarded mutation/save 使用。hello/status 从对应 root 的 `EditorUndoRedoManager` history 读取同一 version，不能使用 Core 自增计数替代。

- [ ] **Step 6: Core 在发送桥接命令前校验项目指纹**

```ts
async function prepareEditorMutation(options: EditorMutationLookupOptions): Promise<void> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  if (!options.expectedScenePath.startsWith("res://")) {
    throw new RuntimeFailure({
      code: "EDITOR_SCENE_PATH_INVALID",
      stage: "validation",
      message: "expectedScenePath must be a res:// scene path.",
      recovery: ["Read godot_project_context or godot_editor_status and pass the exact scene path."],
    });
  }
}
```

- [ ] **Step 7: 更新全部调用点和文档化兼容行为**

现有测试、CLI 示例、里程碑脚本中的持久场景修改全部传入当前场景路径；save/undo/redo 还传入刚由 open/mutation/history 返回的 version。旧工具名不变；缺少 `expectedScenePath` 返回 `EDITOR_SCENE_PATH_REQUIRED`，缺少 history version 返回 `EDITOR_HISTORY_VERSION_REQUIRED`，而不是修改未知场景。

`docs/migrations/0.2.md` 明确列出两项破坏性输入变化（Task 2 file guard、Task 4 scene/history guard）、受影响的 MCP/CLI 工具、旧调用失败示例、新调用顺序、如何通过 `godot_project_context` / `godot_editor_status` / mutation receipt 获取前置条件。安全 guard 不设静默兼容期；旧客户端得到可执行恢复建议。仓库包/MCP Server 的 `0.2.0` 版本在 Task 9C 收口时统一更新，避免中间提交伪装成已发布兼容版本。

把共享版本拆为 `EDITOR_PROTOCOL_VERSION = "0.4.0"` 与 `RUNTIME_PROTOCOL_VERSION = "0.3.0"`；`EditorBridgeInfoSchema` 和 `editor_bridge.gd` 使用前者，Runtime schema、`runtime_entry.gd` 保持后者。`validateBridgeHandshake` 显式接收 expected version，不能再从共享常量猜 kind。为现有 doctor 的 `protocolVersion` 暂保 deprecated `PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION` alias，并 additive 返回 `protocolVersions: { editor, runtime }`；Task 9C 记录移除计划。Editor hello capabilities 增加 `scene_open`；Core、Addon 和测试夹具必须在同一提交升级。协议不匹配继续快速失败，不做静默降级。

- [ ] **Step 8: 验证并提交**

Run: `pnpm exec vitest run tests/integration/editor-plugin.test.ts tests/integration/runtime-bridge.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts`

Expected: PASS；错场景测试证明没有新增节点；切标签或 stale history 的 save/undo/redo 零修改；显式打开后可对新活动场景执行读取；Editor 报 `0.4.0`，Runtime 仍以 `0.3.0` 完成 hello、截图、输入和 assert，证明 Editor 升级未破坏 Runtime。

```powershell
git add packages/protocol/src/index.ts packages/core/src/editor.ts packages/core/src/runtime.ts packages/core/src/doctor.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts addons/godot_agent_runtime/editor_bridge.gd tests/integration/editor-plugin.test.ts tests/integration/runtime-bridge.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts docs/migrations/0.2.md
git commit -m "feat: guard editor mutations by scene identity"
```

---

### Task 5: 类型安全的场景批处理与单次 Undo/Redo

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/editor.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `addons/godot_agent_runtime/editor_bridge.gd`
- Modify: `tests/integration/editor-plugin.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Modify: `tests/unit/addon.test.ts`
- Modify: `tests/unit/bridge-handshake.test.ts`
- Modify: `tests/unit/protocol-versions.test.ts`
- Modify: `docs/security.md`
- Modify: `docs/migrations/0.2.md`

**Interfaces:**
- Produces: `EditorBatchOperationSchema` tagged union.
- Produces: `batchEditorScene(options: EditorBatchOptions): Promise<EditorBatchResult>`.
- Produces MCP/CLI: `godot_editor_batch` / `editor-batch`.
- Batch fields: required `expectedScenePath`, required `expectedProjectFingerprint`, `actionName`, `operations` (1–32), `confirmDestructive`；没有 `save` 字段。

- [ ] **Step 1: 定义并测试严格 Schema**

```ts
const BoundedEditorPropertiesSchema = z.record(z.string().min(1), z.unknown())
  .refine((value) => Object.keys(value).length <= 100, "At most 100 properties are allowed.");

export const EditorBatchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("node_create"), parentPath: z.string(), type: z.string(), name: z.string(), properties: BoundedEditorPropertiesSchema.default({}) }).strict(),
  z.object({ op: z.literal("node_update"), nodePath: z.string(), name: z.string().optional(), properties: BoundedEditorPropertiesSchema.default({}) }).strict(),
  z.object({ op: z.literal("node_move"), nodePath: z.string(), newParentPath: z.string(), index: z.number().int().min(-1).optional(), keepGlobalTransform: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("node_delete"), nodePath: z.string() }).strict(),
  z.object({ op: z.literal("scene_instantiate"), parentPath: z.string(), scenePath: z.string().startsWith("res://").endsWith(".tscn"), name: z.string().optional(), properties: BoundedEditorPropertiesSchema.default({}) }).strict(),
  z.object({ op: z.literal("resource_create"), nodePath: z.string(), property: z.string(), type: z.string(), properties: BoundedEditorPropertiesSchema.default({}) }).strict(),
  z.object({ op: z.literal("resource_update"), nodePath: z.string(), property: z.string(), properties: BoundedEditorPropertiesSchema }).strict(),
  z.object({ op: z.literal("instance_set_editable"), nodePath: z.string(), editable: z.boolean() }).strict(),
  z.object({ op: z.literal("signal_connect"), sourcePath: z.string(), signal: z.string(), targetPath: z.string(), method: z.string(), flags: z.number().int().min(0).max(15).optional() }).strict(),
]);
```

Schema 测试必须拒绝未知 `op`、已知 op 的未知字段、超过 100 个属性、第 33 个操作、空操作数组，以及包含删除但 `confirmDestructive !== true` 的请求。

- [ ] **Step 2: 写真实单次撤销测试**

```ts
const batch = await batchEditorScene({
  projectPath,
  runId,
  expectedProjectFingerprint: identity.projectFingerprint,
  expectedScenePath: "res://main.tscn",
  actionName: "Build agent panel",
  operations: [
    { op: "node_create", parentPath: "/root/Main", type: "Panel", name: "BatchPanel", properties: {} },
    { op: "node_create", parentPath: "/root/Main/BatchPanel", type: "Button", name: "BatchButton", properties: { text: "Batch" } },
    { op: "signal_connect", sourcePath: "/root/Main/BatchPanel/BatchButton", signal: "pressed", targetPath: "/root/Main", method: "_on_start_pressed" },
  ],
});
expect(batch).toMatchObject({ operationCount: 3, undoable: true, dirty: true });

const undone = await undoEditorAction({
  projectPath,
  runId,
  expectedScenePath: batch.scenePath,
  expectedHistoryVersion: batch.historyVersion,
});
expect(undone.actionName).toBe("Agent batch: Build agent panel");
await expect(getEditorNode({ projectPath, runId, nodePath: "/root/Main/BatchPanel" }))
  .rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
const redone = await redoEditorAction({
  projectPath,
  runId,
  expectedScenePath: batch.scenePath,
  expectedHistoryVersion: undone.afterVersion,
});
await saveEditorScene({
  projectPath,
  runId,
  expectedScenePath: batch.scenePath,
  expectedHistoryVersion: redone.afterVersion,
});
```

- [ ] **Step 3: 写预校验零修改测试**

批次前两步合法、第三步引用不存在节点；调用必须返回 `EDITOR_BATCH_VALIDATION_FAILED`，并证明前两步都没有落地、Undo 历史版本没有变化。

- [ ] **Step 4: 实现两阶段批处理**

桥接实现必须分为：

1. `_validate_batch(params)`：场景/数量/删除确认校验。
2. `_plan_batch_operation(context, operation, index)`：创建离树 Node/Resource，维护逻辑场景索引，解析前序新节点路径，验证属性、信号、循环移动和名称冲突。
3. `_register_batch_operation(context, plan)`：只向同一个 `EditorUndoRedoManager` action 注册 do/undo，不调用 `commit_action()`。
4. 全部 plan 成功后调用一次 `commit_action()`；返回 dirty/history receipt，不调用场景保存。

```gdscript
_undo_redo.create_action("Agent batch: %s" % action_name, UndoRedo.MERGE_DISABLE, root)
for plan in plans:
	_register_batch_operation(root, plan)
_undo_redo.commit_action()
```

不得复用会自行 `create_action/commit_action` 的现有 `_node_create` 等入口；抽取并复用其路径、属性、Resource 和信号校验 helpers。

operations 按数组顺序观察前序操作形成的“逻辑场景”，而不是一律针对初始树：rename/move 后索引必须重写该节点及全部后代路径，旧路径立即失效；delete 后节点及后代不可再引用；新建父子、实例化后修改、rename 后引用和 move 后引用必须可用。任何一步无法解析都在 `create_action()` 之前以 `EDITOR_BATCH_VALIDATION_FAILED` 返回 index/op/path，真实树与 history version 不变。

Editor hello capabilities 增加 `scene_batch`，并在同一提交把 `EDITOR_PROTOCOL_VERSION` 从 Task 4 的 `0.4.0` 升到 `0.5.0`；Schema、Core expected version、`editor_bridge.gd`、addon/handshake/version tests 和迁移版本表同步更新。旧 `0.4.0` Addon 必须以 `EDITOR_PROTOCOL_VERSION_MISMATCH` 快速失败；匹配 `0.5.0` 却缺少 `scene_batch` 时返回 `EDITOR_CAPABILITY_UNAVAILABLE`。不得退回多次独立 mutation 冒充原子批次。

- [ ] **Step 5: 返回有界逐步结果**

`EditorBatchResult` 返回 `runId`、`scenePath`、`actionName`、`operationCount`、`results`（最多 32 项，每项含 `index/op/path/action`）、`undoable: true`、`dirty: true`、`historyVersion`。不得回传完整节点树，也不得返回容易被误解为已落盘的 `saved` 字段。

保存是独立的 guarded 操作：batch 成功即表示内存树已应用并可一次撤销；随后 `godot_editor_scene_save` 失败只代表磁盘未保存，不能把 batch 伪装成失败或自动撤销。测试通过只读目标/故障注入令 save 失败，断言 batch 节点仍在、history version 未倒退、磁盘重开不含改动；随后显式 undo 可完整恢复内存树。这样调用方总能区分 `applied` 与 `persisted`。

- [ ] **Step 6: 注册 MCP/CLI 并验证未知 raw op 被 Schema 拒绝**

CLI：

```text
editor-batch PROJECT_PATH RUN_ID --project-fingerprint HASH --scene RES_PATH --operations JSON_ARRAY [--action-name TEXT] [--confirm-destructive true|false]
```

MCP annotation 根据是否包含删除无法动态改变，因此工具静态标记 `destructiveHint: true`；描述明确普通创建批次不删除内容。

- [ ] **Step 7: 运行真实 Godot 验证并提交**

Run: `pnpm exec vitest run tests/integration/editor-plugin.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts`

Expected: PASS；单次 undo 删除整个批次，redo 完整恢复；非法批次零修改；rename/move/delete 后引用语义明确；未知/附加字段和属性超限在 MCP 参数校验阶段失败；显式保存失败不改变“batch 已应用、未落盘”的诚实状态；Editor `0.5.0` 握手与 `0.4.0` mismatch 均被测试。

```powershell
git add packages/protocol/src/index.ts packages/core/src/editor.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts addons/godot_agent_runtime/editor_bridge.gd tests/integration/editor-plugin.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts docs/security.md docs/migrations/0.2.md
git commit -m "feat: add typed atomic editor batches"
```

---

### Task 6: 结构化项目设置、InputMap 与外部 Resource 检查

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/editor.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `addons/godot_agent_runtime/editor_bridge.gd`
- Modify: `tests/integration/editor-plugin.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Modify: `tests/unit/addon.test.ts`
- Modify: `tests/unit/bridge-handshake.test.ts`
- Modify: `tests/unit/protocol-versions.test.ts`
- Modify: `docs/security.md`
- Modify: `docs/migrations/0.2.md`

**Interfaces:**
- Produces: `getEditorProjectSetting`, `setEditorProjectSetting`, `upsertEditorInputAction`, `inspectEditorResourcePath`.
- Produces MCP/CLI: `godot_editor_project_setting_get/set`, `godot_editor_input_action_upsert`, `godot_editor_resource_inspect`.
- 持久项目配置修改同时要求 `expectedProjectFingerprint` 与 `expectedProjectFileSha256`：Core 在项目/run 路由权威层验证 fingerprint 并持有 Task 2 的 `project.godot` mutation lease 覆盖整个 Bridge 请求；Bridge 在实际写入点验证磁盘 SHA/cache baseline。结果返回 before/after SHA-256，`undoable: false`。

- [ ] **Step 1: 写项目设置并发保护测试**

```ts
const context = await getProjectContext({ projectPath, editorRunId: runId });
const changed = await setEditorProjectSetting({
  projectPath,
  runId,
  expectedProjectFingerprint: context.identity.projectFingerprint,
  expectedProjectFileSha256: context.identity.projectFileSha256,
  key: "display/window/size/viewport_width",
  value: 960,
});
expect(changed).toMatchObject({ changed: true, undoable: false, previousValue: 640, value: 960 });

await expect(setEditorProjectSetting({
  projectPath,
  runId,
  expectedProjectFingerprint: context.identity.projectFingerprint,
  expectedProjectFileSha256: context.identity.projectFileSha256,
  key: "display/window/size/viewport_height",
  value: 540,
})).rejects.toMatchObject({ payload: { code: "PROJECT_FILE_CONFLICT" } });
```

- [ ] **Step 2: 写 InputMap 与 Resource 检查测试**

```ts
const input = await upsertEditorInputAction({
  projectPath,
  runId,
  expectedProjectFingerprint: identity.projectFingerprint,
  expectedProjectFileSha256: refreshedSha,
  name: "agent_jump",
  deadzone: 0.5,
  replaceEvents: true,
  events: [{ type: "key", physicalKeycode: 32 }],
});
expect(input.events).toHaveLength(1);

const resource = await inspectEditorResourcePath({
  projectPath,
  runId,
  path: "res://agent_button_style.tres",
  properties: ["bg_color"],
});
expect(resource.resource.class).toBe("StyleBoxFlat");
```

- [ ] **Step 3: 运行测试并确认命令缺失**

Run: `pnpm exec vitest run tests/integration/editor-plugin.test.ts`

Expected: FAIL，缺少新增 Core API 或桥接命令。

- [ ] **Step 4: 实现受限项目设置命令**

允许：

```text
application/config/*
application/run/main_scene
display/window/*
rendering/*
physics/2d/*
physics/3d/*
```

拒绝 `autoload/*`、`editor_plugins/*`、`filesystem/import/*` 和 `input/*`；InputMap 只能走专用 typed 工具。宽前缀不是任意值入口：默认只允许修改 `ProjectSettings.has_setting(key)` 为真的键；新增键必须进入逐键 allowlist。输入使用有界 tagged Variant（首版仅 `bool/int/float/string/string_array`，字符串最多 16 KiB、数组最多 256 项），并与现有 Godot Variant 类型一致；`application/run/main_scene` 另行校验为项目内 `.tscn`。

Bridge 在启动/hello 时计算并保存 `loadedProjectFileSha256`。Core 先用 `assertProjectFingerprint` 验证请求，再通过 managed-run metadata 证明 `runId` 绑定同一 canonical project，随后对 `res://project.godot` 获取 Task 2 的同一跨进程 mutation lease，并在持锁 callback 内完成整个 Bridge round trip。每个配置写请求携带 UUID `operationId`；Bridge 在有界内存表中记录 `running|succeeded|failed`、before/after SHA 和错误，并提供同一 `project_settings` capability 下的固定 `project_setting_operation_status` 命令。Bridge 不重复实现平台路径指纹算法；它在任何 `set_setting()` 之前重新哈希磁盘 `project.godot`，并要求：

1. expected SHA 等于当前磁盘 SHA，否则 `PROJECT_FILE_CONFLICT`；
2. 当前磁盘 SHA 等于 Bridge 的 `loadedProjectFileSha256`，否则 `EDITOR_PROJECT_SETTINGS_STALE`，恢复建议要求重启受管 Editor 重新加载，而不是用旧内存覆盖外部修改。

桥接随后调用 `ProjectSettings.set_setting()` / `ProjectSettings.save()`；非零错误返回 `EDITOR_PROJECT_SETTING_SAVE_FAILED`。成功后重新哈希磁盘、更新 bridge baseline 与 operation receipt；Core 只有在得到 succeeded/failed receipt 后才正常释放 lease。配置写的 Bridge 最大执行期限固定为 30 秒，Core lease TTL/quarantine 至少 90 秒并持续 heartbeat。

若客户端 transport 先超时，Core 把结果标为 `EDITOR_PROJECT_SETTING_RESULT_UNKNOWN`，继续持锁并用 operation status 调和到 30 秒期限；Bridge 不可达时停止该受管 Editor 并等待进程退出，再读取磁盘 hash 判断 before/after。仍无法证明 Bridge 已停止或操作终态时，不释放 lease，而是写入 `quarantineUntil`；第二 writer 在安全期限前得到 `PROJECT_MUTATION_INDETERMINATE`，不能插入。Bridge 的 SHA/cache 检查是内容写入权威点，Core 的 fingerprint/run binding 是项目身份权威点。

真实测试必须覆盖：(a) Editor 启动后外部修改 `project.godot`，调用方使用新旧任一 hash 都不会被旧 ProjectSettings cache 覆盖；(b) 配置工具持锁期间，另一个进程用 `godot_file_write` 修改 `project.godot` 必须等待并在重验 guard 后失败；(c) 注入延迟 save 令客户端先超时，第二 writer 在 operation receipt、Editor 终止或 quarantine 安全期限确认前始终被拒绝，最终 receipt/hash 能确定真实落盘状态。

- [ ] **Step 5: 实现 typed InputMap 事件**

首版事件使用每个分支 `.strict()` 的有界 union，只含：

```ts
type InputBinding =
  | { type: "key"; keycode?: number; physicalKeycode?: number; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }
  | { type: "mouse_button"; buttonIndex: number }
  | { type: "joypad_button"; buttonIndex: number; device?: number };
```

action name 必须匹配 `^[A-Za-z0-9_.-]{1,64}$`；`deadzone` 为 `0..1`；每次最多 32 个事件。key 分支要求 `keycode` 与 `physicalKeycode` 恰有一个且为正整数；mouse/joypad button 和 device 使用 Godot 合法有界范围。桥接创建对应 `InputEventKey` / `InputEventMouseButton` / `InputEventJoypadButton`，写入 `ProjectSettings.set_setting("input/<name>", {"deadzone": deadzone, "events": events})`，保存后调用 `InputMap.load_from_project_settings()`。Schema 测试覆盖未知字段、空事件、非法名称、deadzone 越界、两个 key 字段同时存在/都不存在和第 33 个事件。

Editor hello capabilities 同时增加 `project_settings`、`input_map` 和 `resource_inspect`，并把 `EDITOR_PROTOCOL_VERSION` 从 Task 5 的 `0.5.0` 升到 `0.6.0`；Schema、Core、Bridge、addon/handshake/version tests 与迁移表同提交更新。旧 `0.5.0` Addon 以版本不匹配快速失败；匹配版本缺能力时 Core 给出重新安装 Addon 的结构化恢复建议。

- [ ] **Step 6: 实现外部 Resource 只读检查**

只接受项目内 `.tres` / `.res`，拒绝链接，加载后复用现有 tagged Variant 序列化；最多返回请求的 100 个属性，不传属性时只返回类、路径和可编辑属性名摘要。

- [ ] **Step 7: 注册 MCP/CLI、运行验证并提交**

Run: `pnpm exec vitest run tests/integration/editor-plugin.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts`

Expected: PASS；项目设置 stale hash 与 editor-cache stale 均在零修改状态拒绝；配置工具与普通 file writer 并发时 lease/CAS 阻止覆盖；现有 setting 的 Variant 类型不匹配被拒绝；InputMap 保存后重新加载项目仍存在且所有 strict/bound 测试通过；Resource 路径逃逸和链接被拒绝；Editor `0.6.0`/旧 `0.5.0` mismatch 测试通过。

```powershell
git add packages/protocol/src/index.ts packages/core/src/editor.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts addons/godot_agent_runtime/editor_bridge.gd tests/integration/editor-plugin.test.ts tests/integration/mcp-server.test.ts tests/unit/addon.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts docs/security.md docs/migrations/0.2.md
git commit -m "feat: add structured project configuration tools"
```

---

### Task 7: 诊断漏斗、日志整形、调试报告与 MCP 调用日志

**Files:**
- Create: `packages/core/src/diagnostics.ts`
- Create: `packages/core/src/debug-report.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/managed-run.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Create: `tests/unit/diagnostics.test.ts`
- Create: `tests/unit/debug-report.test.ts`
- Modify: `tests/integration/managed-run.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Create: `tests/integration/mcp-stdio.test.ts`
- Modify: `docs/security.md`

**Interfaces:**
- Produces: `readManagedLogs(options): Promise<LogReadResult>` with byte cursors.
- Produces: `getDiagnosticsSummary(options): Promise<DiagnosticsSummary>`.
- Produces: `createDebugReport(options): Promise<DebugReportResult>`.
- Produces MCP/CLI: `godot_log_read`, `godot_diagnostics`, `godot_debug_report`。
- Adds environment flag `GODOT_AGENT_RUNTIME_MCP_DEBUG=1` for per-call structured stderr logging.
- `godot_log_read` input: required `projectPath/runId`，optional `cursor/stream/minimumSeverity/contains/maxLines/deduplicate/raw`；output 包含独立流 cursor、带 `stream` 的有界 entries、hidden/truncated。
- `godot_diagnostics` input: required `projectPath/runId`，optional `cursor/maxIssues`；output 只从受管 run 状态与日志推导 counts/issues/nextActions/nextCursor。
- `godot_debug_report` input: required `projectPath/expectedProjectFingerprint/issue`，optional `runId/reproduction/cursor/format`；output 为 create-only 报告 receipt。三者都使用 `.strict()` Schema，runId 不存在/错项目沿用结构化 managed-run 错误。

- [ ] **Step 1: 写去重、过滤和游标失败测试**

```ts
const shaped = shapeLogLines([
  "ERROR: Missing node",
  "ERROR: Missing node",
  "WARNING: Deprecated call",
  "regular output",
], { minimumSeverity: "warning", deduplicate: true, maxLines: 100 });

expect(shaped.entries).toEqual([
  { severity: "error", message: "ERROR: Missing node", count: 2 },
  { severity: "warning", message: "WARNING: Deprecated call", count: 1 },
]);
expect(shaped.hidden).toMatchObject({ belowSeverity: 1, duplicates: 1 });
```

日志游标测试先读取已有内容获得 `nextCursor`，追加一行，再使用该 cursor 只返回新增行。

- [ ] **Step 2: 写脱敏报告失败测试**

```ts
const report = await renderDebugReport({
  issue: "Button crashes",
  projectPath: "C:/Users/Alice/game",
  protocolVersions: { editor: "0.6.0", runtime: "0.3.0" },
  diagnostics: [],
  logs: [{ severity: "error", message: "token=secret-value", count: 1 }],
});
expect(report).not.toContain("secret-value");
expect(report).toContain("token=[REDACTED]");
expect(report).toContain("Button crashes");
```

- [ ] **Step 3: 运行单元测试并确认模块不存在**

Run: `pnpm exec vitest run tests/unit/diagnostics.test.ts tests/unit/debug-report.test.ts`

Expected: FAIL，缺少诊断与报告模块。

- [ ] **Step 4: 实现有界日志读取**

`LogCursor` 为 `{ stdoutBytes, stderrBytes }`；每个流从 cursor 偏移读取，单次合计最多 1 MiB。参数支持：`stream=stdout|stderr|combined`、`minimumSeverity=error|warning|info`、`contains`、`maxLines=1..500`、`deduplicate`、`raw`。`raw=true` 仍遵守字节和行数上限。

cursor 按原始字节推进，但解码只能在完整 UTF-8 code point 边界结束；末尾半个字符留到下一次读取，不能产生替换字符或重复。`combined` 明确定义为“分别读取后按 stdout block、stderr block 返回，entry 带 stream”，不宣称恢复两个独立文件的真实交错时间；需要真实时序时以后增加写入端序号事件流，首版不伪造顺序。

- [ ] **Step 5: 实现诊断摘要与下一步建议**

```ts
export const NextActionSchema = z.object({
  tool: z.string().startsWith("godot_"),
  reason: z.string().min(1),
  required: z.boolean(),
});
```

`godot_diagnostics` 返回 error/warning/unique/repeated 计数、最多 50 个去重问题、日志 cursor 和：

- 有脚本解析错误：`godot_script_check` 或 `godot_project_check`。
- 有被截断/未读完的运行时错误：required `godot_log_read`。
- 受管 Runtime 正在运行且当前无错误：optional `godot_runtime_assert`，理由必须写成“诊断干净不证明交互”，不得声称知道调用方尚未验证。
- 任一受管进程仍是 running：optional `godot_run_stop` 作为清理建议；已 exited/stopped 的 run 不建议再次 stop。

`required:true` 只能来自当前可观察事实（例如解析失败、日志截断），不能依赖未持久化的工作流历史。若未来需要“已经交互验证”的 required 判断，必须由调用方传入经过 Schema 校验的 verification receipt，不能从无错误日志猜测。

- [ ] **Step 6: 生成安全报告文件**

报告先校验 `expectedProjectFingerprint`，再通过 Task 2 的 mutation lock + create-only publish 写入 `res://.godot/agent-runtime/reports/debug-<timestamp>-<nonce>.md|json`，返回路径、字节数、SHA-256、包含的 section 和 `reviewRequired: true`。只包含 doctor 摘要、Editor/Runtime 独立协议版本、引擎版本、能力表、诊断、经过过滤的日志、runId 和用户提供的复现说明；不读取项目源码，不记录令牌、环境变量值或完整 MCP 参数。错项目、碰撞或写入失败不留下半份报告。

- [ ] **Step 7: 给 MCP `handle` 增加工具名和耗时日志**

```ts
async function handle<T extends Record<string, unknown>>(
  tool: string,
  operation: () => Promise<T>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const result = await operation();
    logMcpCall({ tool, ok: true, durationMs: Math.round(performance.now() - started) });
    return success(result);
  } catch (error) {
    const payload = toRuntimeError(error);
    logMcpCall({ tool, ok: false, durationMs: Math.round(performance.now() - started), code: payload.code, stage: payload.stage });
    return failure(error);
  }
}
```

Debug flag关闭时只记录失败；开启时记录所有调用。日志 JSON 只能写 stderr，字段固定为 `tool/ok/durationMs/code/stage`，不记录参数。

- [ ] **Step 8: 注册 MCP/CLI 并做真实 stdio 隔离验证**

除 InMemoryTransport Schema 测试外，`mcp-stdio.test.ts` 必须 spawn 构建后的 `packages/mcp-server/dist/bin.js`，经 stdin 发送 initialize/list/call 帧，并分别捕获 stdout/stderr：stdout 每一帧都能被 MCP parser 完整解析；debug flag 开/关两种情况下 stderr 日志只含固定字段，不出现请求参数、测试 secret、项目文件内容或令牌。

Run: `pnpm exec vitest run tests/unit/diagnostics.test.ts tests/unit/debug-report.test.ts tests/integration/managed-run.test.ts tests/integration/mcp-server.test.ts tests/integration/mcp-stdio.test.ts`

Expected: PASS；重复错误被折叠并保留 count；cursor 不重复返回旧日志且多字节边界无损；combined 不伪造时序；报告不含测试 secret；真实 MCP stdout 只有协议帧，stderr 日志固定且脱敏。

- [ ] **Step 9: 提交**

```powershell
git add packages/core/src/diagnostics.ts packages/core/src/debug-report.ts packages/protocol/src/index.ts packages/core/src/managed-run.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts tests/unit/diagnostics.test.ts tests/unit/debug-report.test.ts tests/integration/managed-run.test.ts tests/integration/mcp-server.test.ts tests/integration/mcp-stdio.test.ts docs/security.md
git commit -m "feat: add structured diagnostics and debug reports"
```

---

### Task 8: 截图证据语义与诚实性元数据

**Files:**
- Create: `packages/core/src/evidence.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/editor.ts`
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `addons/godot_agent_runtime/editor_bridge.gd`
- Modify: `addons/godot_agent_runtime/runtime_entry.gd`
- Create: `tests/unit/evidence.test.ts`
- Modify: `tests/unit/bridge-handshake.test.ts`
- Modify: `tests/unit/protocol-versions.test.ts`
- Modify: `tests/integration/editor-plugin.test.ts`
- Modify: `tests/integration/runtime-bridge.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Modify: `tests/agent-benchmarks/milestone-1/run.mjs`
- Modify: `tests/agent-benchmarks/milestone-2/run.mjs`
- Modify: `tests/agent-benchmarks/milestone-3/run.mjs`

**Interfaces:**
- Produces: `EvidenceMetadataSchema`.
- Existing `godot_editor_screenshot` and `godot_runtime_screenshot` keep all old fields and add `evidence`.
- Existing screenshot inputs add optional `expectedScenePath`; MCP 与 CLI 同步暴露。
- No unified screenshot tool and no synthetic offscreen scene renderer.

- [ ] **Step 1: 写证据元数据失败测试**

```ts
expect(runtimeScreenshot.evidence).toMatchObject({
  class: "runtime_frame",
  projectFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  scenePath: "res://main.tscn",
  runId,
  provesRuntime: true,
  provesInteraction: false,
});
expect(runtimeScreenshot.evidence.limitations).toContain(
  "A single frame does not prove motion or input-driven behavior.",
);
```

编辑器截图必须是 `class: "editor_viewport"`、`provesRuntime: false`，并包含当前编辑场景。

- [ ] **Step 2: 运行目标测试并确认 `evidence` 缺失**

Run: `pnpm exec vitest run tests/unit/evidence.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts tests/integration/editor-plugin.test.ts tests/integration/runtime-bridge.test.ts tests/integration/mcp-server.test.ts`

Expected: FAIL，截图结果没有 `evidence`。

- [ ] **Step 3: 定义 additive 证据 Schema**

```ts
const EvidenceBaseSchema = z.object({
  capturedAt: z.string().datetime(),
  projectFingerprint: Sha256Schema,
  scenePath: z.string().startsWith("res://").nullable(),
  runId: z.uuid(),
  provesInteraction: z.literal(false),
  limitations: z.array(z.string().min(1)).min(1),
  warnings: z.array(z.string().min(1)),
}).strict();

export const EvidenceMetadataSchema = z.discriminatedUnion("class", [
  EvidenceBaseSchema.extend({
    class: z.literal("editor_viewport"),
    provesRuntime: z.literal(false),
  }).strict(),
  EvidenceBaseSchema.extend({
    class: z.literal("runtime_frame"),
    provesRuntime: z.literal(true),
  }).strict(),
]);
```

Schema 测试必须证明 `editor_viewport + provesRuntime:true`、`runtime_frame + provesRuntime:false`、`provesInteraction:true` 和未知字段均被拒绝。

- [ ] **Step 4: 在捕获命令内原子绑定场景身份与时间**

不得在截图后再调用 hello/info 猜 scene。Editor Bridge 的同一个 `screenshot` 请求在等待/捕获前记录活动 root 的实例 id + scene path 并校验可选 `expectedScenePath`，PNG 写完后再次读取；Runtime Bridge 同样在捕获前后读取 `get_tree().current_scene` 的实例 id + scene path（不能只用 launch metadata）。前后稳定才返回完成时的 `scenePath/capturedAt`；调用前不匹配返回 `EVIDENCE_SCENE_MISMATCH`，捕获期间变化则删除刚生成的 PNG 并返回 `EVIDENCE_SCENE_CHANGED_DURING_CAPTURE`，不能留下被错误标记的证据。

Core 调用 `getProjectIdentity` 交叉绑定 project fingerprint，只消费 Bridge 的稳定捕获 receipt，不用请求参数填 scene。为这项 transport 结果变化，把 `EDITOR_PROTOCOL_VERSION` 从 Task 6 的 `0.6.0` 升到 `0.7.0`、`RUNTIME_PROTOCOL_VERSION` 从 `0.3.0` 升到 `0.4.0`，两个 GDScript bridge、Schema、handshake fixture 和 integration tests 在同一提交升级；capabilities 增加 `screenshot_receipt`，旧 Addon 快速失败并提示重装。`docs/migrations/0.2.md` 同步版本表。

- [ ] **Step 5: 更新里程碑证据包**

三个 benchmark 保存 `evidence` 原样到报告；现有 path/width/height/bytes/sha256 字段不变。断言明确要求：编辑器截图不能满足运行时完成条件，运行时单帧不能替代 `godot_runtime_assert`。竞态 fixture 必须让场景在截图等待帧期间真实切换并验证 PNG 已删除，而不是只测试调用前 mismatch。

- [ ] **Step 6: 验证并提交**

Run:

```powershell
pnpm exec vitest run tests/unit/evidence.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts tests/integration/editor-plugin.test.ts tests/integration/runtime-bridge.test.ts tests/integration/mcp-server.test.ts
pnpm run benchmark:milestone-1
pnpm run benchmark:milestone-2
pnpm run benchmark:milestone-3
```

Expected: 每条命令 exit 0；两类截图语义正确；编辑器切标签/运行时切场景竞态测试证明 metadata 与实际捕获稳定绑定且临时 PNG 被删除；错场景证据被拒绝；Editor `0.7.0` 与 Runtime `0.4.0` 各自握手通过且互不串用版本；milestone 1–3 的新 evidence 报告通过 Schema。

```powershell
git add packages/core/src/evidence.ts packages/protocol/src/index.ts packages/core/src/editor.ts packages/core/src/runtime.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts addons/godot_agent_runtime/editor_bridge.gd addons/godot_agent_runtime/runtime_entry.gd tests/unit/evidence.test.ts tests/unit/bridge-handshake.test.ts tests/unit/protocol-versions.test.ts tests/integration/editor-plugin.test.ts tests/integration/runtime-bridge.test.ts tests/integration/mcp-server.test.ts tests/agent-benchmarks/milestone-1/run.mjs tests/agent-benchmarks/milestone-2/run.mjs tests/agent-benchmarks/milestone-3/run.mjs docs/migrations/0.2.md
git commit -m "feat: classify screenshot evidence"
```

---

### Task 9: Agent Playbook、任务配方、里程碑 5 与文档收口

**Files:**
- Create: `packages/core/src/agent-guidance.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/cli/src/bin.ts`
- Create: `tests/unit/agent-guidance.test.ts`
- Modify: `tests/unit/summer-capability-matrix.test.ts`
- Modify: `tests/integration/mcp-server.test.ts`
- Create: `tests/agent-benchmarks/milestone-5/run.mjs`
- Modify: `tests/agent-benchmarks/deepseek-harness/task.md`
- Modify: `tests/agent-benchmarks/deepseek-harness/report.schema.json`
- Modify: `packages/protocol/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/mcp-server/package.json`
- Modify: `packages/cli/package.json`
- Modify: `package.json`
- Modify only if workspace importer metadata changes: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `adapters/agent-recipes.md`
- Modify: `docs/architecture.md`
- Modify: `docs/tool-contracts.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/comparisons.md`
- Modify: `docs/security.md`
- Modify: `LICENSING.md`

**Interfaces:**
- Produces Core: `getAgentGuide(recipeId?: RecipeId): AgentGuideResult`，作为 MCP、CLI 和文档测试的唯一 guidance 数据源。
- Produces one MCP/CLI surface: `godot_agent_guide` / `agent-guide [recipe-id]`；无 id 返回 playbook + recipe 摘要，有 id 返回单个 recipe。
- Recipe IDs: `edit-and-verify-ui`, `edit-and-verify-3d`, `fix-script-error`, `safe-scene-batch`, `collect-debug-report`.
- Produces command: `pnpm run benchmark:milestone-5`.

- [ ] **Step 1: 写 playbook 完整性失败测试**

```ts
const playbook = getAgentGuide().playbook;
expect(playbook.startupChecklist[0]).toContain("godot_project_context");
expect(playbook.verificationLadder.map((step) => step.id)).toEqual([
  "context", "compile", "edit", "visual", "runtime", "interactive", "cleanup",
]);
expect(playbook.honestyRules).toContain(
  "Do not claim interaction success from screenshot evidence alone.",
);

for (const recipe of getAgentGuide().recipes) {
  for (const tool of recipe.tools) expect(advertisedToolNames).toContain(tool);
}
```

- [ ] **Step 2: 运行测试并确认指导模块不存在**

Run: `pnpm exec vitest run tests/unit/agent-guidance.test.ts`

Expected: FAIL，Core 缺少 `agent-guidance.ts`。

- [ ] **Step 3: 实现静态、无状态的指导数据**

Playbook 固定包含：

1. 首次调用 `godot_project_context`，不猜主场景。
2. 文本修改优先 `godot_file_replace`，整文件写入必须 guard。
3. 多节点构建优先 typed `godot_editor_batch`。
4. 编译验证先 `godot_script_check`，项目级再 `godot_project_check`。
5. 先 `godot_diagnostics`，按 `nextActions` 再读取日志。
6. 截图只证明对应 evidence class；交互成功必须 wait/assert。
7. 所有启动的受管进程最终调用 `godot_run_stop`。

`godot_agent_guide` 无 `recipeId` 时返回 playbook 和 recipe 摘要列表，有 id 时返回目标、前置条件、有序工具、成功判据、证据要求和清理步骤；不执行工具、不保存任务状态。数据放在 Core，MCP/CLI 只能调用该 API，禁止复制常量或从 MCP 包反向导入。

决策记录：MCP Resource/Prompt 在不同客户端（尤其当前 DSH benchmark）上的支持与发现路径不一致，因此首版使用一个 tool 保证 tool-only 客户端可用，而不是再增加 playbook/recipe 两个工具。Task 9B 必须记录 initialize/list_tools 的工具总数与序列化 Schema 字节数：以本轮前 49 tools 的实际字节数为冻结 baseline，本计划新增 13 个工具后总数必须精确为 62，Schema 总字节不得超过 baseline 的 1.5 倍，MCP instructions UTF-8 不得超过 4 KiB。确定性脚本不统计任何模型工具选择指标。若超出预算，优先把详细 guidance 移到 Resource、合并真正同域的新工具或缩短描述，不能简单抬高阈值。

- [ ] **Step 4: 更新 MCP Server instructions**

替换当前单段说明，使其要求先读取上下文，需要详细流程时再调用 `godot_agent_guide`，并明确固定验证阶梯。MCP 工具测试检查 instructions 中出现 `godot_project_context`、`godot_agent_guide`、`godot_diagnostics`、`godot_runtime_assert` 和 `godot_run_stop`，且列表只新增一个 guidance 工具。

Run: `pnpm exec vitest run tests/unit/agent-guidance.test.ts tests/integration/mcp-server.test.ts`

Expected: PASS；Core/CLI/MCP 使用同一 guidance 数据，工具列表只新增 `godot_agent_guide`。

```powershell
git add packages/core/src/agent-guidance.ts packages/protocol/src/index.ts packages/core/src/index.ts packages/mcp-server/src/server.ts packages/cli/src/bin.ts tests/unit/agent-guidance.test.ts tests/integration/mcp-server.test.ts
git commit -m "feat: add shared agent guidance"
```

- [ ] **Step 5: 建立里程碑 5 真实 Godot 验收**

`tests/agent-benchmarks/milestone-5/run.mjs` 在临时复制的 `examples/control-ui` 上按顺序验证：

1. 获取 context 与 project fingerprint。
2. 使用唯一文本替换并验证 stale write 冲突。
3. 启动 EditorPlugin，错 `expectedScenePath` 零修改。
4. typed batch 创建 Panel、Button、StyleBox 和 signal，断言只产生一个 history action 且尚未落盘。
5. 使用 batch receipt 的 scene/history guard 一次 undo 全部撤销、一次 redo 全部恢复，再显式 scene save 并从磁盘重开验证；另以故障注入证明 save 失败不会伪装成 batch 未应用。
6. 用项目指纹和新的项目文件 hash 写入一个 InputMap action，并重启 Editor 回读。
7. 运行 `godot_script_check` 和 `godot_project_check`。
8. 启动游戏，用 UI find/input/wait/assert 证明交互。
9. 采集 runtime evidence、diagnostics、增量日志和 debug report。
10. 停止全部受管进程；报告记录每一步耗时、工具调用数、证据路径和 SHA-256。

新增脚本：

```json
"benchmark:milestone-5": "pnpm run build && node tests/agent-benchmarks/milestone-5/run.mjs"
```

- [ ] **Step 6: 更新跨客户端基准契约**

DeepSeek Harness 任务增加 context、batch、diagnostics 和 evidence 要求；报告 Schema 新增 `contextCalls`、`batchCalls`、`diagnosticCalls`、`evidenceClasses`、`cleanup`、`toolCount`、`toolSchemaBytes`、`instructionsBytes`。不得把未配置模型凭据写成已验证结果；无凭据只验证 MCP 握手、Schema 和这些确定性上下文预算，不生成 Agent 选择率。

Run: `pnpm run benchmark:milestone-5`

Expected: exit 0；DSH Schema 单测通过；未配置模型凭据时只记录 `hostExecutionVerified:false`，不生成工具选择率。

```powershell
git add tests/agent-benchmarks/milestone-5/run.mjs tests/agent-benchmarks/deepseek-harness/task.md tests/agent-benchmarks/deepseek-harness/report.schema.json package.json
git commit -m "test: add optimized MCP closure benchmark"
```

- [ ] **Step 7: 更新用户/维护者文档并完成最终版本变更**

在任何最终验证之前，把根包、protocol/core/mcp-server/cli 和 MCP Server initialize version 统一升到 `0.2.0`；不改 Task 8 已确定的 Editor `0.7.0` / Runtime `0.4.0` transport 版本。`mcp-server.test.ts` 必须从真实 initialize 响应断言 `serverInfo.version === "0.2.0"`。若 workspace 版本更新确实改变 lockfile，先运行对应 lockfile-only 更新并把 `pnpm-lock.yaml` 纳入本 Task 文件/提交清单；否则不制造无关 diff。此步骤结束后，Step 8 之前不得再改 manifests、initialize version 或生成 lockfile。

文档必须清楚区分：

- 从 Summer 借鉴的是公开行为/接口思想，未复制定制引擎代码。
- Summer 能力矩阵必须记录冻结的公开来源 commit/tag，所有工具均有且仅有一个采用/适配/已有/拒绝/延期结论；上游差异不得静默忽略。
- 本项目在结构化运行时观察、断言、确定性推进和隔离物理仿真方面保留自己的优势。
- batch 是 typed fixed-command，不是 raw op。
- `godot_file_write` 的 guard 迁移要求和结构化错误。
- MCP/CLI `0.2.0` 的 scene/history guard 迁移、Editor/Runtime 独立 transport 版本和旧客户端错误示例。
- screenshot evidence 的证明范围。
- 项目设置/InputMap 的允许前缀和非 Undo 文件副作用。
- Cloud、AI 资产生成、账号、任意探针仍明确不做。

`LICENSING.md` 记录本轮为基于公开文档的独立实现；若执行中实际复制 MIT 源码片段，必须在同一提交加入原版权与许可证声明，否则禁止复制。

在 `tests/unit/summer-capability-matrix.test.ts` 增加 Task 9C 专属断言：解析更新后的 `docs/comparisons.md` 机器标记区，验证投影 item 总数和五类 decision 计数与 `summer-mcp-decisions.json` 完全一致。Task 1 阶段不运行这条文档投影断言；只有 Task 9C 文档生成后启用，Step 8 的完整测试提供最终证据。

- [ ] **Step 8: 运行完整验证矩阵**

Run:

```powershell
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run benchmark:milestone-1
pnpm run benchmark:milestone-2
pnpm run benchmark:milestone-3
pnpm run benchmark:milestone-4
pnpm run benchmark:milestone-5
pnpm run benchmark:runtime
```

Expected: 每条命令 exit 0；Vitest 0 failures；真实 stdio 测试通过；五个 milestone 和 runtime benchmark 各生成新的时间戳证据目录；里程碑 4 只声明实际执行过的客户端/凭据门槛；报告包含工具总数/Schema 字节数和 Summer 矩阵未分类数 `0`。

- [ ] **Step 9: 提交已验证的迁移、版本与文档**

Run: `git status --short`

Expected: Task 9A/9B 已分别提交；工作区只包含 Step 7 已经通过完整矩阵验证的 `0.2.0` manifests/initialize version、文档，以及被 Git 忽略的 `artifacts/` 证据。没有临时 token、日志或目标项目副本。`git add` 后运行 `git diff --cached --check` 与 `git diff --cached --name-only`，禁止目录级 `git add docs`。

```powershell
git add package.json packages/protocol/package.json packages/core/package.json packages/mcp-server/package.json packages/cli/package.json packages/mcp-server/src/server.ts pnpm-lock.yaml tests/unit/summer-capability-matrix.test.ts README.md adapters/agent-recipes.md docs/architecture.md docs/tool-contracts.md docs/roadmap.md docs/comparisons.md docs/security.md docs/migrations/0.2.md LICENSING.md
git commit -m "docs: publish MCP optimization migration"
```

---

## Final Acceptance Criteria

1. Agent 不提供项目上下文时仍可执行只读发现；所有新增写入必须带项目指纹，并在实际写入权威点叠加适用的内容 hash、场景路径或 history version 前置条件。
2. 无 guard 文件写入失败，旧的安全 `expectedSha256` 写入保持兼容，文本替换默认只允许唯一匹配；同 guard 并发写最多一个成功，外部不遵循 lease 的竞态边界被如实记录。
3. 错项目指纹、错活动场景、stale history、stale `project.godot`/Editor cache、未知 batch op 和非法路径均在零修改状态下失败。
4. 一个合法 batch 最多 32 步，只形成一次 Undo/Redo action且不隐式保存；一次 guarded undo/redo 完整回退/恢复，独立 save 的成功/失败不歪曲 batch 已应用状态。
5. `godot_script_check` 比完整项目启动更轻量，并对真实解析错误返回文件级结构化诊断。
6. 诊断摘要先分流，日志读取支持 cursor、过滤和重复计数，调试报告脱敏且要求用户发送前审阅。
7. 每张截图明确属于编辑器视口或真实运行帧，携带项目/场景身份和限制；单帧不能被解释为交互证明。
8. Playbook/recipe 由 Core 单一数据源提供，只通过一个 guidance 工具服务 tool-only 客户端且不执行任意工作流；MCP、CLI、Codex 和 DSH 共享同一语义。
9. 现有四个里程碑不回归；里程碑 5 对新增安全与易用性能力提供真实 Godot 端到端证据。
10. 仓库仍使用原版 Godot、固定命令表和本地优先架构，不新增 Summer 运行时依赖或在线服务依赖。
11. Summer 冻结工具集合全部进入决策矩阵且未分类数为 0；MCP/CLI `0.2.0` 迁移文档列全 file guard、scene/history guard 与独立 Editor/Runtime transport 版本。
12. 严格 capability 协商下，每个命令表扩展都有独立 Editor transport 版本与 mismatch 回归：Tasks 4/5/6/8 依次为 `0.4.0/0.5.0/0.6.0/0.7.0`；Runtime 只在 Task 8 从 `0.3.0` 升到 `0.4.0`。

## Execution Order and Review Gates

- Gate A（Tasks 1–3）：项目身份、文件安全、上下文和脚本检查通过后，先评审协议命名与兼容策略。
- Gate B（Tasks 4–6）：场景前置条件、batch、项目配置通过真实 EditorPlugin 测试后，评审 Undo/Redo 与非 Undo 文件副作用。
- Gate C（Tasks 7–8）：诊断和 evidence 通过脱敏/诚实性测试后，评审上下文成本和证据边界。
- Gate D（Task 9）：全套测试和 milestone 证据通过后，才更新完成状态与发布说明。
