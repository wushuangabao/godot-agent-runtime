# Godot Agent Runtime npm Release and GalGame Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 发布公共 npm 包 godot-agent-runtime@0.2.0，并只通过该固定公共版本为 E:\github\GalGame 生成可复现、幂等、项目级的 Codex MCP 与 Godot 插件接入。

**Architecture:** 保留 TypeScript MCP/CLI -> Core -> loopback Godot Bridge 分层。仓库根包成为唯一公共 npm 包，esbuild 把所有私有 workspace 代码打进单一 ESM bin，只把 MCP SDK 与 Zod 留作生产依赖；MIT addon 和受管 host 作为受控资产随 tarball 发布。setup codex 在写入前完成全部输入与写入计划校验，再原子写本机配置、Codex 受管区段和插件，最后以明确的 res://addons/godot_agent_runtime/plugin.cfg 启用插件。GalGame 只提交 MIT 插件快照与复现入口，不提交机器配置，也不复制 AGPL 核心源码。

**Tech Stack:** Node.js 20+、TypeScript 7、pnpm 11、esbuild、Vitest 4、MCP SDK 2、Zod 4、PowerShell、Godot 4.6.2 stable。

## Global Constraints

- 设计真源是 docs/superpowers/specs/2026-08-26-npm-release-and-galgame-integration-design.md；实现不得放宽其中的发布、许可证、失败处理或证据边界。
- runtime 实现在当前 main 上进行。每个 Task 开始前检查工作区，只提交该 Task 的精确文件；不改写历史，不混入用户文件。
- runtime 发行提交、origin/main 推送、v0.2.0 标签推送和 npm publish 已获用户授权，但只有全部发行门禁通过后才能执行。
- GalGame 接入允许本地提交；未经另行授权不得推送 GalGame。
- 公共入口只有 godot-agent-runtime。内部 @godot-agent-runtime/* 包保持 private: true 与 workspace:*，不得作为公共包生产依赖发布。
- 根包的生产依赖集合必须精确为 @modelcontextprotocol/server 与 zod；所有内部 workspace 代码必须打包，开发工具与测试客户端不得进入 dependencies。
- npm 包不得使用 postinstall 下载、Git clone、在线回退、全盘资产搜索、模型 API、账号、遥测或任意脚本探针。
- 不创建 GitHub Release，不把 runtime 作为 GalGame 的 submodule、subtree 或源码副本，不生成全局 Codex MCP 配置。
- addons/godot_agent_runtime 整个目录采用 MIT 并带目录 LICENSE 与四个 SPDX 标识；其余未另行标注代码仍为 AGPL-3.0-or-later。
- 新安装只写 res://addons/godot_agent_runtime/plugin.cfg；0.2.x 读取时继续识别旧裸名称 godot_agent_runtime，并由安装器迁移、去重到唯一明确路径。
- setup 的用户输入验证和所有写入计划必须在第一次写操作前完成。单文件写入原子且有 create/SHA-256 guard；跨文件失败如实报告 partial results，幂等重跑必须收敛。
- 正式 Godot 验收只使用 D:\Godot\Godot_v4.6.2-stable_win64.exe。自编译 Godot 只能用于开发定位，不能替代发行证据。
- 每个代码 Task 遵循 TDD：先写失败测试并看到预期失败，再做最小实现，再跑聚焦与相关回归测试，最后提交。
- 发布后的 0.2.0 不覆盖、不 unpublish、不复用版本号；若 registry 已存在或发布后发现问题，停止 0.2.0 流程并另行设计 0.2.1。
- 当前 Codex 任务不能热加载刚生成的 MCP 配置。本轮用独立 MCP Client 证明握手；只有重新打开任务后才能证明 Codex UI 已加载新工具。

---

## File Map

| 文件 | 责任 |
|---|---|
| package.json、pnpm-lock.yaml、tsconfig.json | 公共根包契约、发行脚本、固定构建依赖与 release package 引用 |
| packages/release/src/bin.ts | 单一公共 bin；配置 npm 发行布局并分派 mcp 或 CLI |
| packages/cli/src/main.ts、packages/cli/src/bin.ts | 可导入 CLI 主函数与源码模式薄 wrapper |
| packages/mcp-server/src/index.ts、packages/mcp-server/src/bin.ts | 可导入 stdio 启动函数与源码模式薄 wrapper |
| packages/core/src/distribution.ts | 源码检出与 npm tarball 的唯一资产/客户端启动布局 |
| packages/core/src/config.ts | configPath、环境变量、workspace local、legacy 的配置优先级 |
| packages/core/src/client-config.ts | 通用 stdio launcher 与受管客户端配置的计划/应用 |
| packages/core/src/addon.ts | MIT addon 文件集、明确插件路径、legacy 迁移、计划/应用 |
| packages/core/src/setup.ts | setup codex 的预检、全量计划、顺序应用和 partial result |
| packages/protocol/src/index.ts | addon 与 setup 的结构化结果契约 |
| scripts/build-npm-package.mjs | 清理、esbuild、资产复制、metafile 与 import 边界检查 |
| scripts/verify-npm-package.mjs | pack 白名单、外部安装、CLI/MCP/资产/Godot 发行门禁 |
| addons/godot_agent_runtime/* | MIT Godot EditorPlugin 与 Runtime Bridge 源资产 |
| README.md、LICENSING.md、adapters/codex/README.md | 公共安装、许可边界、Codex 重启和源码兼容说明 |
| E:\github\GalGame\scripts\setup-godot-agent-runtime.ps1 | 固定 0.2.0 的唯一 GalGame 初始化入口 |
| E:\github\GalGame\.godot-agent-runtime\config.example.json | 不含机器路径的 schema v1 示例 |
| E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\* | 从公共 tarball 安装并提交的 MIT 快照 |
| E:\github\GalGame\AGENTS.md | Codex 在 GalGame 中的结构化开发与验证约束 |

---

### Task 0: 固定已批准的实施计划

**Files:**
- Create: docs/superpowers/plans/2026-08-26-npm-release-and-galgame-integration.md

- [ ] **Step 1: 核对计划与设计的机械一致性**

Run:

~~~powershell
rg -n "res://addons/godot_agent_runtime/plugin.cfg|dist/npm/bin/godot-agent-runtime.js|@modelcontextprotocol/server|SPDX-License-Identifier: MIT|prepublishOnly|npm whoami" docs/superpowers/plans/2026-08-26-npm-release-and-galgame-integration.md
rg -n "T[O]DO|T[B]D|F[I]XME|待[定]|稍后[补]|省[略]" docs/superpowers/plans/2026-08-26-npm-release-and-galgame-integration.md
git diff --check
~~~

Expected: 第一条覆盖全部硬契约；第二条没有输出；diff check 通过。

- [ ] **Step 2: 单独提交计划**

~~~powershell
git add docs/superpowers/plans/2026-08-26-npm-release-and-galgame-integration.md
git diff --cached --check
git commit -m "docs: plan npm release and GalGame integration"
~~~

Expected: 只提交本计划；产品代码仍未改变。

---

### Task 1: 固化 MIT addon 边界与明确插件路径

**Files:**
- Create: addons/godot_agent_runtime/LICENSE
- Modify: addons/godot_agent_runtime/plugin.cfg
- Modify: addons/godot_agent_runtime/plugin.gd
- Modify: addons/godot_agent_runtime/editor_bridge.gd
- Modify: addons/godot_agent_runtime/runtime_entry.gd
- Modify: packages/core/src/addon.ts
- Modify: packages/core/src/editor.ts
- Modify: packages/protocol/src/index.ts
- Modify: packages/core/src/index.ts
- Modify: tests/unit/addon.test.ts
- Modify: tests/integration/editor-plugin.test.ts
- Modify: README.md
- Modify: LICENSING.md

**Interfaces:**

~~~ts
export const GODOT_AGENT_PLUGIN_ID = "godot_agent_runtime" as const;
export const GODOT_AGENT_PLUGIN_PATH =
  "res://addons/godot_agent_runtime/plugin.cfg" as const;
export const GODOT_AGENT_LEGACY_PLUGIN_NAME = "godot_agent_runtime" as const;

export function isGodotAgentRuntimeEnabled(
  enabledPlugins: readonly string[],
): boolean;

export interface AddonInstallResult {
  readonly ok: true;
  readonly projectPath: string;
  readonly plugin: "godot_agent_runtime";
  readonly pluginPath: "res://addons/godot_agent_runtime/plugin.cfg";
  readonly files: readonly string[];
  readonly projectConfigurationChanged: boolean;
}
~~~

- [ ] **Step 1: 记录许可来源并写失败测试**

运行：

~~~powershell
git log --format="%H%x09%an%x09%ae" -- addons/godot_agent_runtime
~~~

Expected: addon 历史作者邮箱与已审设计记录一致；若出现未获授权的第三方版权所有者，立即停止许可证修改并报告。把核查结论写入提交说明，不把个人凭据写进仓库。

在 tests/unit/addon.test.ts 增加：

- 新项目安装后 files 精确包含 LICENSE、plugin.cfg、plugin.gd、editor_bridge.gd、runtime_entry.gd。
- project.godot 只含 res://addons/godot_agent_runtime/plugin.cfg。
- 仅有旧裸名称时迁移为明确路径。
- 同时含裸名称、明确路径和重复项时收敛为一个明确路径，其他插件顺序不变。
- isGodotAgentRuntimeEnabled 对明确路径与旧裸名称都返回 true，对无关名称返回 false。
- AddonInstallResult.pluginPath 为明确路径。

在 tests/integration/editor-plugin.test.ts 把新安装断言改为明确路径，并保留一个 legacy 项目能通过启动前置检查的回归用例。

- [ ] **Step 2: 运行失败测试**

Run:

~~~powershell
pnpm exec vitest run tests/unit/addon.test.ts tests/integration/editor-plugin.test.ts
~~~

Expected: FAIL；现有实现只复制四个文件、返回裸名称且不能完成 canonical migration。

- [ ] **Step 3: 实现 canonical enablement**

在 packages/core/src/addon.ts：

1. 把 ADDON_FILES 改为上面五个固定文件。
2. 导出三个常量与 isGodotAgentRuntimeEnabled。
3. enablePlugin 解析 editor_plugins.enabled 的全部字符串，只删除等于旧裸名称或明确路径的项，在第一次相关项位置放入一个明确路径；没有相关项时在末尾追加。
4. 保留所有其他插件及其相对顺序。
5. 安装完整五文件成功后才更新 project.godot。
6. 返回 pluginPath。

在 packages/core/src/editor.ts 的启动前置条件使用 isGodotAgentRuntimeEnabled，不再写死裸名称判断。

在 packages/protocol/src/index.ts 对 AddonInstallResultSchema 增加 additive 字段：

~~~ts
pluginPath: z.literal("res://addons/godot_agent_runtime/plugin.cfg"),
~~~

- [ ] **Step 4: 建立文件级 MIT 边界**

把仓库现有 examples/LICENSE 的完整 MIT 文本逐字复制到 addon 目录；其版权行为 Copyright (c) 2026 Godot Agent Runtime contributors，不另行猜测个人版权所有者。四个已有文件首部增加与语法相容的 SPDX-License-Identifier: MIT；plugin.cfg 使用分号注释，三个 GDScript 文件使用井号注释。

README.md 与 LICENSING.md 明确：

- 根 JS/TS、CLI、MCP 为 AGPL-3.0-or-later。
- addons/godot_agent_runtime 由其目录 LICENSE 覆盖为 MIT。
- 用户项目只需复制 MIT addon；npm 中的 AGPL 程序作为独立工具运行。

- [ ] **Step 5: 聚焦验证并提交**

Run:

~~~powershell
pnpm exec vitest run tests/unit/addon.test.ts tests/integration/editor-plugin.test.ts
pnpm run typecheck
git diff --check
~~~

Expected: PASS；新安装只产生明确路径，legacy 仍可读且会迁移，五个 addon 文件均有明确许可边界。

Commit:

~~~powershell
git add addons/godot_agent_runtime packages/core/src/addon.ts packages/core/src/editor.ts packages/core/src/index.ts packages/protocol/src/index.ts tests/unit/addon.test.ts tests/integration/editor-plugin.test.ts README.md LICENSING.md
git commit -m "feat: canonicalize MIT Godot addon installation"
~~~

---

### Task 2: 建立源码与 npm 共用的发行布局

**Files:**
- Create: packages/core/src/distribution.ts
- Modify: packages/core/src/addon.ts
- Modify: packages/core/src/godot.ts
- Modify: packages/core/src/managed-run.ts
- Modify: packages/core/src/client-config.ts
- Modify: packages/core/src/index.ts
- Create: tests/unit/distribution.test.ts
- Modify: tests/unit/client-config.test.ts
- Modify: tests/integration/managed-run.test.ts

**Interfaces:**

~~~ts
export type DistributionKind = "source" | "npm";

export interface ClientLauncher {
  readonly command: string;
  readonly args: readonly string[];
}

export interface DistributionLayout {
  readonly kind: DistributionKind;
  readonly version: string;
  readonly addonRoot: string;
  readonly hostScript: string;
  readonly mcpLauncher: ClientLauncher;
}

export function createSourceDistribution(anchorUrl?: string): DistributionLayout;
export function createNpmDistribution(
  anchorUrl: string,
  version: string,
): DistributionLayout;
export function configureDistribution(layout: DistributionLayout): void;
export function getDistribution(): DistributionLayout;
~~~

Npm layout 固定为：

~~~text
package/dist/npm/bin/godot-agent-runtime.js
package/dist/npm/assets/addons/godot_agent_runtime/
package/dist/npm/assets/host/run-host.mjs
~~~

其 MCP launcher 固定为 command=npx，args=-y, godot-agent-runtime@0.2.0, mcp。源码 layout 继续使用 process.execPath 加 packages/mcp-server/dist/bin.js。

createSourceDistribution 从 packages/core/dist/distribution.js 的 anchor 精确解析 ../../../addons/godot_agent_runtime、../host/run-host.mjs、../../mcp-server/dist/bin.js。createNpmDistribution 从 dist/npm/bin/godot-agent-runtime.js 的 anchor 精确解析 ../assets/addons/godot_agent_runtime 与 ../assets/host/run-host.mjs。

- [ ] **Step 1: 写失败测试**

tests/unit/distribution.test.ts 覆盖：

- source layout 解析到仓库 addon、packages/core/host/run-host.mjs 和源码 MCP bin。
- npm layout 只解析 anchor 相邻的 ../assets，不回退仓库路径。
- 重复配置相同 layout 幂等；不同 layout 二次配置返回 DISTRIBUTION_ALREADY_CONFIGURED。
- 不暴露测试专用 reset API；需要不同全局布局的测试使用 Vitest 文件级模块隔离，生产进程只能保持一次布局。
- 缺少 addon 或 host 时返回 DISTRIBUTION_ASSET_MISSING，details 含 kind 与精确 path，recovery 不包含联网下载。

tests/unit/client-config.test.ts 增加 npm launcher 用例，期望 Codex 受管区段精确为：

~~~toml
# >>> godot-agent-runtime managed section >>>
[mcp_servers.godot-agent-runtime]
command = "npx"
args = ["-y", "godot-agent-runtime@0.2.0", "mcp"]
cwd = "E:\\github\\GalGame"
# <<< godot-agent-runtime managed section <<<
~~~

同时保留现有源码 Node launcher、Claude Code 与 DeepSeek Harness 用例。

- [ ] **Step 2: 运行失败测试**

Run:

~~~powershell
pnpm exec vitest run tests/unit/distribution.test.ts tests/unit/client-config.test.ts tests/integration/managed-run.test.ts
~~~

Expected: FAIL；distribution API 尚不存在，现有三个资产路径仍硬编码为源码相对路径。

- [ ] **Step 3: 实现唯一布局边界**

packages/core/src/distribution.ts 使用 fileURLToPath 与 resolve 构造绝对路径。getDistribution 在未显式配置时返回 source layout；configureDistribution 只允许在进程处理命令前配置一次。所有资产访问在真正使用前以 constants.R_OK 验证，并通过 RuntimeFailure 返回稳定错误。

替换以下硬编码：

- addon.ts 的源码相对 addon 路径改为 getDistribution().addonRoot。
- godot.ts 的 runtime_entry.gd 改为 addonRoot/runtime_entry.gd。
- managed-run.ts 的 host 相对路径改为 getDistribution().hostScript。
- client-config.ts 不再假设 serverPath；接受 ClientLauncher。保留 --server 时显式构造 Node launcher。

ClientConfigurationResult 改为兼容性字段加 launcher：

~~~ts
export interface ClientConfigurationResult {
  readonly ok: true;
  readonly target: ClientTarget;
  readonly path: string;
  readonly serverPath: string | null;
  readonly launcher: ClientLauncher;
  readonly operation: "created" | "updated" | "unchanged";
}
~~~

源码模式 serverPath 保持绝对路径；npm launcher 时为 null。

- [ ] **Step 4: 回归并提交**

Run:

~~~powershell
pnpm exec vitest run tests/unit/distribution.test.ts tests/unit/client-config.test.ts tests/unit/addon.test.ts tests/integration/managed-run.test.ts
pnpm run typecheck
git diff --check
~~~

Expected: PASS；源码开发入口不变，npm layout 不依赖 sibling 仓库。

Commit:

~~~powershell
git add packages/core/src/distribution.ts packages/core/src/addon.ts packages/core/src/godot.ts packages/core/src/managed-run.ts packages/core/src/client-config.ts packages/core/src/index.ts tests/unit/distribution.test.ts tests/unit/client-config.test.ts tests/integration/managed-run.test.ts
git commit -m "feat: add source and npm distribution layouts"
~~~

---

### Task 3: 配置优先级与可预检的原子写入计划

**Files:**
- Create: packages/core/src/atomic-file.ts
- Modify: packages/core/src/config.ts
- Modify: packages/core/src/client-config.ts
- Modify: packages/core/src/addon.ts
- Modify: packages/core/src/index.ts
- Modify: tests/unit/config.test.ts
- Modify: tests/unit/client-config.test.ts
- Modify: tests/unit/addon.test.ts

**Interfaces:**

~~~ts
export type PlannedOperation = "created" | "updated" | "unchanged";

export interface PlannedTextWrite {
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly operation: PlannedOperation;
}

export interface PlannedProjectFileWrite {
  readonly projectPath: string;
  readonly resourcePath: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly operation: PlannedOperation;
}

export async function planAtomicTextWrite(
  path: string,
  content: string,
): Promise<PlannedTextWrite>;
export async function applyAtomicTextWrite(
  plan: PlannedTextWrite,
): Promise<PlannedOperation>;

export async function resolveConfigPath(
  explicitPath?: string,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Promise<string>;

export interface ClientConfigurationPlan {
  readonly result: Omit<ClientConfigurationResult, "operation">;
  readonly write: PlannedTextWrite;
}

export interface AddonInstallPlan {
  readonly projectPath: string;
  readonly pluginPath: "res://addons/godot_agent_runtime/plugin.cfg";
  readonly addonWrites: readonly PlannedProjectFileWrite[];
  readonly projectWrite: PlannedProjectFileWrite;
}
~~~

- [ ] **Step 1: 用 hermetic 测试固定配置优先级**

重写 tests/unit/config.test.ts，不依赖被忽略的真实 config/development.local.json。每个用例创建临时目录，覆盖：

1. explicit configPath 胜过所有其他来源。
2. GODOT_AGENT_RUNTIME_CONFIG 胜过 workspace local 与 legacy。
3. 存在 .godot-agent-runtime/config.local.json 时选它。
4. local 不存在时回退 config/development.local.json。
5. 四处均不存在时返回 CONFIG_NOT_FOUND，recovery 列出四种来源。
6. schema version 1 与 Godot executable 校验保持不变。

在 client-config 与 addon 单测增加 plan 阶段不写文件、apply 后才写、current SHA 改变时拒绝覆盖、unchanged 不改 mtime 的用例。

- [ ] **Step 2: 确认测试先失败**

Run:

~~~powershell
pnpm exec vitest run tests/unit/config.test.ts tests/unit/client-config.test.ts tests/unit/addon.test.ts
~~~

Expected: FAIL；当前 config 只解析 legacy 路径，client/addon 只有立即写入 API。

- [ ] **Step 3: 提取原子文本写入**

atomic-file.ts 的 plan 阶段读取当前内容并计算 SHA-256；apply 阶段重新读取并比较 expectedSha256，随后在同目录写唯一临时文件并原子 rename。创建与更新均不跟随符号链接，失败返回 ATOMIC_WRITE_CONFLICT 或 ATOMIC_WRITE_FAILED。

client-config.ts 导出 planClientConfiguration 与 applyClientConfigurationPlan；现有 configureClient 变成两者的兼容组合。

addon.ts 导出 planGodotAddonInstall 与 applyGodotAddonInstallPlan；apply 顺序固定为：

1. 按固定文件名应用五个 addon writes。
2. 再次确认五文件内容与计划 SHA。
3. 最后应用 project.godot write。

任一步失败把已完成目标放进 details.completedTargets；installGodotAddon 继续作为兼容组合 API。

- [ ] **Step 4: 实现配置解析顺序**

config.ts 只在候选存在时选择 local/legacy；显式 path 与环境变量即使不存在也必须返回该路径并让 loadConfig 报精确读取失败，不能静默降级。环境变量值不得出现在诊断内容中，只能报告所选 path 和 source。

- [ ] **Step 5: 回归并提交**

Run:

~~~powershell
pnpm exec vitest run tests/unit/config.test.ts tests/unit/client-config.test.ts tests/unit/addon.test.ts tests/unit/safe-file.test.ts
pnpm run typecheck
git diff --check
~~~

Expected: PASS；所有测试只使用临时目录，plan 阶段零写入，apply 有并发保护。

Commit:

~~~powershell
git add packages/core/src/atomic-file.ts packages/core/src/config.ts packages/core/src/client-config.ts packages/core/src/addon.ts packages/core/src/index.ts tests/unit/config.test.ts tests/unit/client-config.test.ts tests/unit/addon.test.ts
git commit -m "feat: plan atomic runtime configuration writes"
~~~

---

### Task 4: 实现 setup codex 组合命令

**Files:**
- Create: packages/core/src/setup.ts
- Modify: packages/core/src/index.ts
- Modify: packages/protocol/src/index.ts
- Modify: packages/cli/src/bin.ts
- Create: tests/unit/setup.test.ts
- Create: tests/integration/setup-codex.test.ts

**Interfaces:**

~~~ts
export interface SetupCodexOptions {
  readonly workspacePath: string;
  readonly godotProjectPath: string;
  readonly godotExecutable: string;
}

export interface SetupTargetResult {
  readonly target:
    | "local-config"
    | "codex-config"
    | "addon-assets"
    | "project-plugin";
  readonly path: string;
  readonly operation: "created" | "updated" | "unchanged";
}

export interface SetupCodexResult {
  readonly ok: true;
  readonly packageVersion: string;
  readonly workspacePath: string;
  readonly godotProjectPath: string;
  readonly godotExecutable: string;
  readonly godotVersion: string;
  readonly targets: readonly SetupTargetResult[];
  readonly restartRequired: true;
}

export interface SetupCodexPorts {
  readonly nodeVersion: string;
  readonly probeGodotVersion: (executable: string) => Promise<string>;
}

export interface CodexSetupPlan {
  readonly options: SetupCodexOptions;
  readonly godotVersion: string;
  readonly localConfigWrite: PlannedTextWrite;
  readonly clientPlan: ClientConfigurationPlan;
  readonly addonPlan: AddonInstallPlan;
}

export function assertSupportedNodeVersion(version: string): void;
export function createCodexSetupPlan(
  options: SetupCodexOptions,
  ports?: SetupCodexPorts,
): Promise<CodexSetupPlan>;
export function applyCodexSetupPlan(
  plan: CodexSetupPlan,
): Promise<SetupCodexResult>;
export async function setupCodex(
  options: SetupCodexOptions,
): Promise<SetupCodexResult>;
~~~

targets 对每个实际文件返回一项：local config 一项、Codex config 一项、五个 addon asset 各一项、project.godot 一项；因此 target 名允许重复，operation 不做有歧义的聚合。中途失败的 completedTargets 使用同一结构。

CLI grammar:

~~~text
godot-agent-runtime setup codex
  --workspace PATH
  --godot-project PATH
  --godot EXE
~~~

- [ ] **Step 1: 写预检和幂等失败测试**

tests/unit/setup.test.ts 覆盖：

- 缺少任一必填 flag 在 validation 阶段失败。
- Node major 小于 20、workspace 不存在、project.godot 不存在、Godot 文件不可读时，在任何文件产生前失败。
- Godot --headless --version 非 4.x 时零写入失败。
- Codex managed marker 只有一半时零写入失败且原文件字节不变。
- 输入全部有效时先返回或持有四类完整计划，第一处 apply 之前所有目标已经可计算。
- 人为制造中途 SHA 冲突时错误 details.completedTargets 精确列出已完成项，重跑收敛。

tests/integration/setup-codex.test.ts 使用 D:\Godot\Godot_v4.6.2-stable_win64.exe 和临时 Godot 项目，覆盖：

- 第一次 created/updated。
- 第二次四类 target 全部 unchanged。
- Godot version 精确为 4.6.2.stable.official.71f334935。
- Codex 无关 TOML 内容被保留。
- addon 为五文件且 project.godot 只有明确 plugin.cfg 路径。

- [ ] **Step 2: 运行并确认失败**

Run:

~~~powershell
pnpm exec vitest run tests/unit/setup.test.ts tests/integration/setup-codex.test.ts
~~~

Expected: FAIL；setup API 和 CLI 分支尚不存在。

- [ ] **Step 3: 实现全量预检**

setup.ts 在第一次写入前完成：

1. 规范化并验证 workspace、Godot project 与 executable 都是绝对路径。
2. 验证 Node 20+。
3. 验证 workspace 目录、project.godot 普通文件、Godot executable 普通文件。
4. 执行 Godot --headless --version，要求 trimmed stdout 以 4. 开头。
5. 为 workspace/.godot-agent-runtime/config.local.json 生成 schema v1 local config：

~~~json
{
  "schemaVersion": 1,
  "godot": {
    "executable": "D:\\Godot\\Godot_v4.6.2-stable_win64.exe"
  }
}
~~~

6. 调用 planAtomicTextWrite、planClientConfiguration 与 planGodotAddonInstall，验证所有 marker、资产和 guard。
7. 只有上述步骤全部成功后按 local-config、codex-config、addon-assets、project-plugin 顺序 apply。

异常统一为 code、stage、message、details、recovery；已开始 apply 时 details 增加 completedTargets。成功结果打印重启 Codex 提示，但不自动打开或修改全局 Codex 配置。

- [ ] **Step 4: 接入 CLI**

packages/cli/src/bin.ts 的 help 增加 setup codex 行；解析器只接受上述三个 flag，拒绝多余位置参数和未知 flag。调用 setupCodex 并用现有 JSON print 输出。setup 不接受任意命令、hook 或脚本参数。

- [ ] **Step 5: 验证并提交**

Run:

~~~powershell
pnpm exec vitest run tests/unit/setup.test.ts tests/integration/setup-codex.test.ts tests/unit/config.test.ts tests/unit/client-config.test.ts tests/unit/addon.test.ts
pnpm run typecheck
git diff --check
~~~

Expected: PASS；无效输入零写入，第一次收敛，第二次全 unchanged。

Commit:

~~~powershell
git add packages/core/src/setup.ts packages/core/src/index.ts packages/protocol/src/index.ts packages/cli/src/bin.ts tests/unit/setup.test.ts tests/integration/setup-codex.test.ts
git commit -m "feat: add idempotent Codex setup command"
~~~

---

### Task 5: 建立单一公共 bin 与精确 npm 构建契约

**Files:**
- Create: packages/cli/src/main.ts
- Modify: packages/cli/src/bin.ts
- Modify: packages/cli/package.json
- Modify: packages/mcp-server/src/index.ts
- Modify: packages/mcp-server/src/bin.ts
- Create: packages/release/package.json
- Create: packages/release/tsconfig.json
- Create: packages/release/src/bin.ts
- Create: scripts/build-npm-package.mjs
- Modify: package.json
- Modify: pnpm-lock.yaml
- Modify: tsconfig.json
- Create: tests/unit/release-dispatch.test.ts
- Create: tests/integration/npm-build.test.ts

**Public manifest core fields must be exactly:**

~~~json
{
  "name": "godot-agent-runtime",
  "version": "0.2.0",
  "type": "module",
  "license": "AGPL-3.0-or-later",
  "bin": {
    "godot-agent-runtime": "dist/npm/bin/godot-agent-runtime.js"
  },
  "files": [
    "dist/npm/bin/",
    "dist/npm/assets/",
    "README.md",
    "LICENSE",
    "LICENSING.md"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.4.3"
  },
  "publishConfig": {
    "access": "public"
  }
}
~~~

同时删除根 private: true，并把其余公共元数据固定为：

~~~json
{
  "description": "Local-first MCP and CLI runtime for coding agents to automate and verify Godot 4.x projects.",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/wushuangabao/godot-agent-runtime.git"
  },
  "homepage": "https://github.com/wushuangabao/godot-agent-runtime#readme",
  "bugs": {
    "url": "https://github.com/wushuangabao/godot-agent-runtime/issues"
  },
  "keywords": [
    "godot",
    "mcp",
    "codex",
    "automation",
    "testing",
    "agent"
  ]
}
~~~

内部 package manifests 均继续 private: true。

- [ ] **Step 1: 先写 release dispatch 与构建失败测试**

release-dispatch 单测使用注入函数验证：

- argv 首项为 mcp 时只调用 serveMcpStdio，且移除 mcp 后不调用 CLI。
- 其他 argv 原样交给 runCli。
- 进入任一分支前 configureDistribution(createNpmDistribution(import.meta.url, "0.2.0")) 已完成。
- MCP 模式 stdout 不输出 banner、help 或诊断。
- CLI 的 --version 精确输出 0.2.0 后退出，help 继续列出现有命令、mcp 与 setup codex。

npm-build 集成测试验证：

- 根 manifest 上述字段深相等。
- packages/*/package.json 中除根外均为 private。
- 构建后精确存在一个 bin、五个 addon asset 和一个 host asset。
- JS 第一行为 node shebang。
- metafile 中没有 @godot-agent-runtime/* external import。
- 归一化后的 external family 集合精确为 @modelcontextprotocol/server 与 zod。

- [ ] **Step 2: 运行失败测试**

Run:

~~~powershell
pnpm exec vitest run tests/unit/release-dispatch.test.ts tests/integration/npm-build.test.ts
~~~

Expected: FAIL；release package、可导入入口和 npm build 尚不存在。

- [ ] **Step 3: 把 CLI 与 MCP bin 改为薄 wrapper**

把 packages/cli/src/bin.ts 的命令实现移动到 main.ts，导出：

~~~ts
export async function runCli(
  argv?: readonly string[],
): Promise<void>;
~~~

默认 argv 为 process.argv.slice(2)。runCli 把 --version 作为顶层稳定参数处理并精确输出 0.2.0。bin.ts 只保留 shebang、runCli 调用、结构化错误输出与 process.exitCode。

packages/mcp-server/src/index.ts 导出：

~~~ts
export async function serveMcpStdio(): Promise<void>;
~~~

它使用 @modelcontextprotocol/server/stdio 和 createMcpServer；bin.ts 只调用该函数并把诊断写 stderr。

- [ ] **Step 4: 实现 release 入口**

packages/release 保持 private: true，源码依赖可使用 workspace:*。release/src/bin.ts 保留 shebang，先配置 npm layout，再分派：

~~~ts
export async function dispatchReleaseCommand(
  argv: readonly string[],
  ports: {
    runCli: (argv: readonly string[]) => Promise<void>;
    serveMcpStdio: () => Promise<void>;
  },
): Promise<void>;
~~~

实际 main 对 mcp 调 serveMcpStdio，对其他命令调 runCli。不得在 MCP stdout 写任何非 JSON-RPC 内容。

- [ ] **Step 5: 实现可重复构建**

在根 devDependencies 增加精确版本 "esbuild": "0.28.2"，并用 pnpm lock 固定。scripts/build-npm-package.mjs：

1. 解析仓库根，拒绝目标不是精确 dist/npm。
2. 删除并重建 dist/npm/bin 与 dist/npm/assets。
3. 用 esbuild bundle release/src/bin.ts，format=esm、platform=node、target=node20、banner 保留 shebang、metafile=true。
4. external 精确配置 @modelcontextprotocol/server、@modelcontextprotocol/server/*、zod、zod/*。
5. 复制 addon 五文件与 packages/core/host/run-host.mjs。
6. 检查实际文件集合，没有额外源文件、map、测试或 package manifest。
7. 扫描 metafile 与最终 JS；内部裸导入为 0，第三方 external family 与根 dependencies 深相等。
8. 任何不一致删除无效产物并非零退出。

根 scripts 增加：

~~~json
{
  "build:npm": "node scripts/build-npm-package.mjs",
  "prepack": "pnpm run build:npm"
}
~~~

- [ ] **Step 6: 验证并提交**

Run:

~~~powershell
pnpm install
pnpm exec vitest run tests/unit/release-dispatch.test.ts tests/integration/npm-build.test.ts tests/integration/mcp-stdio.test.ts
pnpm run build:npm
pnpm run typecheck
git diff --check
~~~

Expected: PASS；dist/npm 与设计树精确一致，bundle 无私有 workspace 运行时导入。

Commit:

~~~powershell
git add package.json pnpm-lock.yaml tsconfig.json packages/cli packages/mcp-server packages/release scripts/build-npm-package.mjs tests/unit/release-dispatch.test.ts tests/integration/npm-build.test.ts
git commit -m "feat: build single public npm executable"
~~~

---

### Task 6: 建立真实 tarball 的发行验证器与公开文档

**Files:**
- Create: scripts/verify-npm-package.mjs
- Create: tests/fixtures/npm-package-allowlist.json
- Modify: package.json
- Modify: tests/integration/mcp-server.test.ts
- Modify: tests/integration/mcp-stdio.test.ts
- Modify: README.md
- Modify: LICENSING.md
- Modify: adapters/codex/README.md
- Create: docs/releases/0.2.0.md

**Release verification contract:**

- npm pack --dry-run --json 与 allowlist 一致。
- npm pack --ignore-scripts 生成的真实 tgz 在仓库外临时目录安装。
- 安装目录的生产依赖顶层 family 精确为 @modelcontextprotocol/server 与 zod。
- 只从安装目录执行 bin，不能引用 E:\github\godot-agent-runtime。
- CLI help/version、MCP initialize/list_tools、兼容性 payload、资产定位、Codex marker 保留、addon 二次安装、Godot 4.6.2 bridge 均通过。

- [ ] **Step 1: 先写 pack allowlist 与失败验证**

tests/fixtures/npm-package-allowlist.json 列出精确 tarball path：

~~~json
[
  "LICENSE",
  "LICENSING.md",
  "README.md",
  "dist/npm/assets/addons/godot_agent_runtime/LICENSE",
  "dist/npm/assets/addons/godot_agent_runtime/editor_bridge.gd",
  "dist/npm/assets/addons/godot_agent_runtime/plugin.cfg",
  "dist/npm/assets/addons/godot_agent_runtime/plugin.gd",
  "dist/npm/assets/addons/godot_agent_runtime/runtime_entry.gd",
  "dist/npm/assets/host/run-host.mjs",
  "dist/npm/bin/godot-agent-runtime.js",
  "package.json"
]
~~~

先运行：

~~~powershell
node scripts/verify-npm-package.mjs
~~~

Expected: FAIL；验证脚本尚不存在或 package contract 尚未满足。

- [ ] **Step 2: 实现外部安装验证器**

verify-npm-package.mjs 支持两个互斥来源：无参数时构建并验证本地 tarball；传入 --package-spec godot-agent-runtime@0.2.0 时只从 registry 安装，禁止读取本仓库 dist/npm。它使用 mkdtemp 在系统临时目录建立 pack、consumer、Godot fixture 三个目录，并在 finally 只清理这些已解析的临时目录。流程：

1. 运行 pnpm run build:npm。
2. 运行 npm pack --dry-run --json，归一化 package/ 前缀后与 allowlist 深相等。
3. 运行 npm pack --ignore-scripts --json，保存 tgz 绝对路径与 sha512。
4. 在 consumer 目录 npm init -y，再 npm install 加该 tgz 的绝对路径。
5. 读取安装后的 package.json 与 npm ls --omit=dev --json，验证版本、bin、files 和两个生产依赖家族。
6. 执行安装后的 bin help 与 --version，要求版本精确为 0.2.0。
7. 通过 MCP Client stdio transport 启动安装后的 bin mcp，执行 initialize、list_tools，并重用 tests/fixtures/mcp-tool-baseline-0.1.json 的兼容性计算。
8. 用安装后的 bin 对临时 workspace 运行 setup codex 两次，检查 marker 保留、第二次 unchanged、五个 addon 文件和 canonical plugin path。
9. 用 D:\Godot\Godot_v4.6.2-stable_win64.exe 启动临时 Editor 与 Runtime Bridge，完成 handshake、状态查询、停止和状态目录清理。

网络安装失败必须归类为发行环境错误，不修改产品依赖边界来规避。

- [ ] **Step 3: 接入 prepublish 门禁**

根 scripts 精确增加：

~~~json
{
  "verify:npm": "pnpm run check && node scripts/verify-npm-package.mjs",
  "prepublishOnly": "pnpm run verify:npm"
}
~~~

verify 脚本内部 npm pack 必须带 --ignore-scripts，避免递归触发 prepack；脚本自己已经先 build:npm。

- [ ] **Step 4: 更新公开文档**

README.md 写明：

~~~powershell
npx -y godot-agent-runtime@0.2.0 setup codex --workspace "E:\github\GalGame" --godot-project "E:\github\GalGame\GodotPrj" --godot "D:\Godot\Godot_v4.6.2-stable_win64.exe"
npx -y godot-agent-runtime@0.2.0 mcp
~~~

adapters/codex/README.md 同步项目级 marker、重开任务、源码模式兼容。docs/releases/0.2.0.md 记录：

- 单公共包和 Node 20+。
- local config 优先级。
- 新安装 canonical plugin path 与 legacy migration。
- addon MIT、核心 AGPL。
- 当前任务不能热加载 MCP。
- 0.2.0 不可覆盖，修复使用新 patch 版本。

- [ ] **Step 5: 全量验证并提交**

Run:

~~~powershell
pnpm run verify:npm
git diff --check
git status --short
~~~

Expected: pnpm check 全绿；真实 tgz 在 monorepo 外安装；CLI、MCP、addon、官方 Godot 4.6.2 全部通过；工作区只有本 Task 的预期文件与生成后被忽略的 dist/npm。

Commit:

~~~powershell
git add package.json scripts/verify-npm-package.mjs tests/fixtures/npm-package-allowlist.json tests/integration/mcp-server.test.ts tests/integration/mcp-stdio.test.ts README.md LICENSING.md adapters/codex/README.md docs/releases/0.2.0.md
git commit -m "test: gate the public npm release"
~~~

---

### Task 7: 最终审查、推送、打标签并发布 0.2.0

**Files:**
- No product file changes expected.

- [ ] **Step 1: 检查不可漂移的发行状态**

Run:

~~~powershell
git status --short --branch
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git log --oneline origin/main..HEAD
npm view godot-agent-runtime@0.2.0 version --json
npm whoami
~~~

Expected:

- 工作区干净。
- origin/main 仍是实现基线的祖先，本地只领先已审设计与发行实现提交。
- registry 返回 0.2.0 不存在；任何已存在结果都停止流程。
- npm whoami 成功且不输出 token。

- [ ] **Step 2: 在待发布提交上重跑全部门禁**

Run:

~~~powershell
pnpm run verify:npm
git diff --check
git status --porcelain
~~~

Expected: 全绿且 status 为空。记录 HEAD、真实 tgz filename、sha512、Godot version 和 MCP tool count；不把 npm credential 写入文件。

- [ ] **Step 3: 推送 main**

Run:

~~~powershell
git push origin main
git rev-parse HEAD
git rev-parse origin/main
~~~

Expected: 两个 SHA 完全相同。推送失败则停止，不创建 tag。

- [ ] **Step 4: 在同一提交创建并推送标签**

Run:

~~~powershell
git tag -a v0.2.0 -m "godot-agent-runtime 0.2.0"
git rev-list -n 1 v0.2.0
git push origin v0.2.0
git ls-remote --tags origin refs/tags/v0.2.0
~~~

Expected: tag peeled commit 与 Step 2 的 HEAD 相同。标签推送失败则停止发布并报告本地、远端标签状态。

- [ ] **Step 5: 从干净提交发布**

Run:

~~~powershell
npm publish --access public
npm view godot-agent-runtime@0.2.0 name version license bin files dependencies dist.integrity --json
~~~

Expected: registry 返回 name=godot-agent-runtime、version=0.2.0、license=AGPL-3.0-or-later、单一 bin、精确 files/dependencies 与 dist.integrity。发布失败则报告 tag 已存在而 npm 未发布的真实状态，不重跑可能产生歧义的破坏性命令。

- [ ] **Step 6: 只从 registry 回验**

在一个新临时目录运行：

~~~powershell
npm init -y
npm install godot-agent-runtime@0.2.0
npx --no-install godot-agent-runtime --version
~~~

运行已经在 Task 6 实现的 registry 模式：

~~~powershell
node scripts/verify-npm-package.mjs --package-spec godot-agent-runtime@0.2.0
~~~

Expected: registry 安装重复通过 CLI、MCP initialize/list_tools、资产、setup 和 Godot 4.6.2 门禁。

---

### Task 8: 仅用公共 0.2.0 接入 GalGame

**Repository:** E:\github\GalGame

**Files:**
- Create: E:\github\GalGame\scripts\setup-godot-agent-runtime.ps1
- Create: E:\github\GalGame\.godot-agent-runtime\config.example.json
- Modify: E:\github\GalGame\.gitignore
- Modify: E:\github\GalGame\AGENTS.md
- Modify: E:\github\GalGame\GodotPrj\project.godot
- Create: E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\LICENSE
- Create: E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\plugin.cfg
- Create: E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\plugin.gd
- Create: E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\editor_bridge.gd
- Create: E:\github\GalGame\GodotPrj\addons\godot_agent_runtime\runtime_entry.gd

- [ ] **Step 1: 固定 GalGame 基线并创建复现脚本**

先检查：

~~~powershell
git -C E:\github\GalGame status --short --branch
git -C E:\github\GalGame rev-parse HEAD
git -C E:\github\GalGame rev-parse origin/main
~~~

Expected: main 干净，HEAD 与用户手动同步后的 origin/main 相同；如出现无关改动，保护它们且不纳入接入提交。

setup-godot-agent-runtime.ps1 完整内容：

~~~powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$GodotPath
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$godotProject = Join-Path $repositoryRoot "GodotPrj"
$npx = Get-Command "npx.cmd" -ErrorAction Stop
$runtimeArguments = @(
    "-y"
    "godot-agent-runtime@0.2.0"
    "setup"
    "codex"
    "--workspace"
    $repositoryRoot
    "--godot-project"
    $godotProject
    "--godot"
    $GodotPath
)

& $npx.Source @runtimeArguments

if ($LASTEXITCODE -ne 0) {
    throw "godot-agent-runtime setup failed with exit code $LASTEXITCODE."
}
~~~

config.example.json 完整内容：

~~~json
{
  "schemaVersion": 1,
  "godot": {
    "executable": "C:\\path\\to\\Godot_v4.6.2-stable_win64.exe"
  }
}
~~~

.gitignore 追加且不覆盖已有规则：

~~~gitignore
/.codex/
/.godot-agent-runtime/config.local.json
~~~

- [ ] **Step 2: 在 AGENTS.md 写入操作与证据边界**

追加一个 Godot Agent Runtime 小节，明确：

1. Godot project root 固定为仓库相对路径 GodotPrj，不写某台机器的绝对仓库路径。
2. 新机器先运行固定脚本并重新打开 Codex 任务。
3. 先 godot_doctor，再 godot_project_context。
4. 文件写使用 project fingerprint 与 create/SHA-256 guard。
5. Editor 持久修改使用 expectedScenePath 与 historyVersion；多节点用 typed batch。
6. 验证顺序为静态检查、受管启动、结构化观察或断言、必要时截图、停止清理。
7. 截图只证明视觉状态；交互由结构化状态或断言证明。
8. 不自动声称真机、导出包、性能或生产发布通过。

- [ ] **Step 3: 运行固定公共版本两次**

Run:

~~~powershell
Set-Location E:\github\GalGame
.\scripts\setup-godot-agent-runtime.ps1 -GodotPath "D:\Godot\Godot_v4.6.2-stable_win64.exe"
.\scripts\setup-godot-agent-runtime.ps1 -GodotPath "D:\Godot\Godot_v4.6.2-stable_win64.exe"
~~~

Expected:

- 第一次 created/updated。
- 第二次四类 target 全部 unchanged。
- .codex/config.toml 与 .godot-agent-runtime/config.local.json 存在但被 Git 忽略。
- GodotPrj/addons/godot_agent_runtime 五文件来自 registry 0.2.0。
- project.godot 只含 res://addons/godot_agent_runtime/plugin.cfg，不含裸名称。

- [ ] **Step 4: 审计 GalGame diff 与许可证**

Run:

~~~powershell
git -C E:\github\GalGame status --short
git -C E:\github\GalGame diff -- .gitignore AGENTS.md GodotPrj/project.godot scripts/setup-godot-agent-runtime.ps1 .godot-agent-runtime/config.example.json GodotPrj/addons/godot_agent_runtime
git -C E:\github\GalGame check-ignore -v .codex/config.toml .godot-agent-runtime/config.local.json
rg -n "godot_agent_runtime|res://addons/godot_agent_runtime/plugin.cfg" E:\github\GalGame\GodotPrj\project.godot
rg -n "SPDX-License-Identifier: MIT" E:\github\GalGame\GodotPrj\addons\godot_agent_runtime
~~~

Expected: diff 仅包含已批准的接入文件；机器配置被忽略；四个源文件有 MIT SPDX；插件启用只有明确路径。

- [ ] **Step 5: 以公开包完成 GalGame 实际闭环**

使用 local config 默认解析，不传 runtime 源码路径：

~~~powershell
Set-Location E:\github\GalGame
npx -y godot-agent-runtime@0.2.0 doctor
npx -y godot-agent-runtime@0.2.0 context "E:\github\GalGame\GodotPrj"
npx -y godot-agent-runtime@0.2.0 check "E:\github\GalGame\GodotPrj"
~~~

Expected: doctor 报告 Node、配置、Godot 4.6.2 与 loopback 基础检查通过；context 返回 project fingerprint；check 无解析错误。

再用一个临时 PowerShell 验收过程捕获 JSON runId，不向仓库写脚本：

1. editor-launch，读取 runId。
2. editor-status 直到 ready。
3. editor-tree 读取当前场景树。
4. stop 并确认退出。
5. launch 启动游戏，读取 runtime runId。
6. status、runtime-tree 或 runtime-observe 读取结构化状态。
7. 对一个只读且稳定的现有属性执行 assert-property；若 GalGame 当前没有稳定断言目标，只验证 runtime-tree 的结构化非空契约，不修改游戏内容。
8. screenshot 保存证据路径与 SHA-256，但不把它当交互成功证据。
9. stop，确认 .godot/agent-runtime 下没有 active 受管状态。

Expected: Editor Bridge 与 Runtime Bridge 都完成版本握手、结构化调用和清理。若主场景本身因现有项目问题无法启动，报告既有错误与日志证据，不为通过接入而修改 GalGame 玩法代码。

- [ ] **Step 6: 独立 MCP Client 验证并本地提交**

用 registry 安装的 MCP SDK client 启动 npx -y godot-agent-runtime@0.2.0 mcp，执行 initialize、list_tools、godot_doctor 与 godot_project_context。stdout 必须只有 JSON-RPC；Codex UI 加载状态留待重新打开任务后确认。

Final verification:

~~~powershell
git -C E:\github\GalGame diff --check
git -C E:\github\GalGame status --short
~~~

精确暂存：

~~~powershell
git -C E:\github\GalGame add -- .gitignore AGENTS.md GodotPrj/project.godot scripts/setup-godot-agent-runtime.ps1 .godot-agent-runtime/config.example.json GodotPrj/addons/godot_agent_runtime
git -C E:\github\GalGame diff --cached --check
git -C E:\github\GalGame diff --cached --name-only
git -C E:\github\GalGame commit -m "chore: integrate Godot agent runtime"
~~~

Expected: 本地提交成功；不包含 .codex/config.toml 或 config.local.json；不推送 GalGame。

---

## Final Evidence Checklist

- [ ] runtime origin/main 指向包含设计与发行实现的同一已验证 commit。
- [ ] v0.2.0 远端标签指向该 commit。
- [ ] npm registry 的 godot-agent-runtime@0.2.0 integrity、manifest 与已验证 tgz 一致。
- [ ] 根包只有一个 bin，tarball 只有 allowlist 文件，生产依赖只有 MCP SDK 与 Zod。
- [ ] bundle 无 @godot-agent-runtime/* 裸导入；源码 workspace 包保持 private。
- [ ] addon 目录有 MIT LICENSE 与四个 SPDX；根核心仍为 AGPL。
- [ ] 新安装只写明确 plugin.cfg 路径；legacy bare name 可读且幂等迁移。
- [ ] setup 无效输入零写入，中断报告 partial results，重跑收敛。
- [ ] GalGame 两次 setup 的第二次全 unchanged。
- [ ] GalGame Editor、Runtime 与 MCP 使用公开 registry 包通过结构化握手与清理。
- [ ] 截图只作为视觉证据；未声称真机、导出、性能或生产发布。
- [ ] GalGame 只有本地接入提交，没有未经授权的 push。
