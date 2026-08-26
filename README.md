# Godot Agent Runtime 0.2.0

Godot Agent Runtime 是面向外部编码 Agent 的本地 Godot 4.x 自动化与自验证层。首个可重复闭环现已可用：安全修改项目文本、静态检查、受管启动/停止、运行时截图、UI 发现、输入注入，以及带 expected/actual/evidence 的结构化交互断言。所有能力通过 stdio MCP 暴露，也提供可组合 CLI。

0.2.0 把这条闭环收敛成显式上下文与可恢复前置条件：先读取 `godot_project_context`，文件修改使用项目 fingerprint 与 create/SHA-256 guard，持久 Editor 修改使用活动场景与原生 history version，多个节点操作使用最多 32 步的严格 typed batch。`godot_agent_guide` / `agent-guide` 从 Core 同一份静态数据返回 playbook 和五个任务配方，不执行工作流、也不保存 Agent 任务状态。

实时 `EditorPlugin` 已提供安装、受管启动、场景树和属性读取、节点增删改与移动、PackedScene 实例化与 Editable Children、真实场景继承、Resource 子属性读写及内置/外部保存、文件系统选择与资源聚焦、信号连接、原生 Undo/Redo、场景保存，以及带活动相机元数据的 2D/3D 编辑器视口截图。Runtime Bridge 通过 Godot `--script` 临时主循环启动，支持有界运行时场景树、节点属性与游戏状态批量观察、Camera3D 世界坐标投影和屏幕物理射线，并可在私有 2D/3D World 中复制场景、注入动作和逐物理帧采样；它不改写目标项目的 `project.godot`，退出后不残留 autoload。

首个里程碑可通过 `pnpm run benchmark:milestone-1` 一键验收。脚本使用临时项目，通过 EditorPlugin 修改并保存 UI，再启动 Runtime Bridge 完成截图、UI 发现、点击、等待和结构化断言；证据包写入被 Git 忽略的 `artifacts/milestone-1/<时间戳>/`。

里程碑 2 可通过 `pnpm run benchmark:milestone-2` 一键验收。脚本创建并运行真实继承场景，批量读取位置、速度、碰撞状态、分组和元数据，在隔离物理 World 中验证 Player 预测移动且不改变真实位置，再注入真实输入完成移动与结构化断言；证据包写入 `artifacts/milestone-2/<时间戳>/`。

里程碑 3 可通过 `pnpm run benchmark:milestone-3` 一键验收。脚本经 EditorPlugin 修改并保存 Node3D 变换、捕获真实 3D 编辑器视口和相机，再启动 CharacterBody3D 场景，通过世界坐标投影、屏幕射线选中、私有 World3D 仿真、真实输入、碰撞状态和前后截图完成完整 3D 自动化闭环；证据包写入 `artifacts/milestone-3/<时间戳>/`。

里程碑 4 的客户端适配验收命令为 `pnpm run benchmark:milestone-4`。它幂等生成 Codex 与 DeepSeek Harness 配置，通过生成的 stdio 命令完成 MCP 握手、工具 Schema 和结构化调用检查，并在隔离的临时 DSH Home 中合成和启动 Headless Profile；报告写入 `artifacts/milestone-4/<时间戳>/`。真实模型闭环任务与报告 Schema 位于 `tests/agent-benchmarks/deepseek-harness/`，需要用户自行配置的 DSH 模型凭据。

里程碑 5 的验收命令为 `pnpm run benchmark:milestone-5`。它在 `examples/control-ui` 的临时副本中串联项目上下文、guarded 文本替换与 stale conflict、错场景零修改、单 action typed batch、Undo/Redo、失败保存诚实性、显式保存、InputMap SHA/重启回读、脚本/项目检查、运行时 find/input/wait/assert、诊断/增量日志/脱敏报告和全量清理。报告记录逐步耗时、调用数、证据类别、路径与 SHA-256；截图始终不充当交互成功证明。该命令的实际通过状态以本机新生成的 Gate D 报告为准。

## 公共 npm 包

要求 Node.js 20+ 和原版 Godot 4.x。以下命令从公共包为一个现有 Godot 项目安装 MIT addon、写入本机 Godot 路径，并只维护项目级 `.codex/config.toml` 中带标记的 MCP 区段：

```powershell
npx -y godot-agent-runtime@0.2.0 setup codex --workspace "E:\github\GalGame" --godot-project "E:\github\GalGame\GodotPrj" --godot "D:\Godot\Godot_v4.6.2-stable_win64.exe"
npx -y godot-agent-runtime@0.2.0 mcp
```

新安装的 EditorPlugin 启用项固定为 `res://addons/godot_agent_runtime/plugin.cfg`；0.2.x 会读取并迁移旧的裸名称 `godot_agent_runtime`。`setup codex` 可重复执行，第二次应全部报告 `unchanged`，并保留 Codex 配置中的非受管内容。Codex 当前任务不能热加载新增 MCP Server；执行 setup 后必须重新打开任务，再先调用 `godot_doctor`。

本机配置解析顺序为：命令显式 `--config`、`GODOT_AGENT_RUNTIME_CONFIG`、当前工作区 `.godot-agent-runtime/config.local.json`、兼容旧路径 `config/development.local.json`。

## 开发

要求 Node.js 20+、pnpm 和 Godot 4.x。复制本机配置示例并填写绝对路径：

```powershell
Copy-Item config/development.local.example.json config/development.local.json
pnpm install
pnpm run build
pnpm run doctor
```

当前本机配置可以用零依赖脚本单独验证：

```powershell
node scripts/check-development-environment.mjs
```

## CLI

```powershell
node packages/cli/dist/bin.js find examples
node packages/cli/dist/bin.js inspect examples/minimal-2d
node packages/cli/dist/bin.js context examples/control-ui
node packages/cli/dist/bin.js agent-guide edit-and-verify-ui
node packages/cli/dist/bin.js file-read examples/control-ui res://main.gd
node packages/cli/dist/bin.js file-replace examples/control-ui res://main.gd --project-fingerprint <HASH> --old "old" --new "new"
node packages/cli/dist/bin.js script-check examples/control-ui res://main.gd
node packages/cli/dist/bin.js check examples/minimal-2d
node packages/cli/dist/bin.js run examples/minimal-2d
node packages/cli/dist/bin.js launch examples/control-ui
node packages/cli/dist/bin.js status examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js stop examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js runtime-ui examples/control-ui <RUN_ID> --text Start --type Button
node packages/cli/dist/bin.js click examples/control-ui <RUN_ID> --path /root/Main/StartButton
node packages/cli/dist/bin.js assert-property examples/control-ui <RUN_ID> --node /root/Main --property meta:started --expected true
node packages/cli/dist/bin.js wait-property examples/control-ui <RUN_ID> --node /root/Main --property meta:started --expected true --wait-timeout 1000
node packages/cli/dist/bin.js runtime-control examples/control-ui <RUN_ID> pause
node packages/cli/dist/bin.js runtime-control examples/control-ui <RUN_ID> step --frames 2
node packages/cli/dist/bin.js runtime-control examples/control-ui <RUN_ID> step_physics --frames 2
node packages/cli/dist/bin.js runtime-control examples/control-ui <RUN_ID> resume
node packages/cli/dist/bin.js runtime-observe examples/physics-2d <RUN_ID> --nodes '["/root/Main/Player"]' --properties '["meta:distance"]'
node packages/cli/dist/bin.js runtime-simulate examples/physics-2d <RUN_ID> --node /root/Main/Player --frames 20 --properties '["position","velocity","meta:distance"]' --action ui_right
node packages/cli/dist/bin.js runtime-3d-project examples/physics-3d <RUN_ID> --node /root/Main/Player
node packages/cli/dist/bin.js runtime-3d-raycast examples/physics-3d <RUN_ID> --x 226 --y 180
node packages/cli/dist/bin.js input-sequence examples/control-ui <RUN_ID> --steps '[{"kind":"click","path":"/root/Main/StartButton","afterMs":20},{"kind":"key","keycode":65,"holdMs":10}]'
node packages/cli/dist/bin.js screenshot examples/control-ui <RUN_ID>
```

`run` 是有限帧 headless 验证，会自动退出；`launch` 打开可见窗口并返回 `runId`，后续由 `status` 查询、由 `stop` 幂等停止。所有命令向标准输出写入 JSON。失败包含稳定的 `code`、`stage`、`message`、`details` 和 `recovery`。

## MCP Server

```powershell
pnpm run mcp
npx -y godot-agent-runtime@0.2.0 mcp
```

stdio 的标准输出只承载 MCP JSON-RPC；服务端诊断写入标准错误。当前工具及契约见 [docs/tool-contracts.md](docs/tool-contracts.md)。

为当前项目生成客户端配置：

```powershell
node packages/cli/dist/bin.js configure codex
node packages/cli/dist/bin.js configure deepseek-harness
```

Codex 配置写入项目级 `.codex/config.toml` 的受管区段；DeepSeek Harness 配置写入 `.dsh/godot-agent-runtime.patch.yml`，通过标准 MCP Client 将工具暴露为 `mcp__godot__godot_*`。DSH 的本机启动方式见 [适配说明](adapters/deepseek-harness/README.md)，两端共用的闭环步骤见 [任务配方](adapters/agent-recipes.md)。已有 Claude Code 配置生成目标暂时保留向后兼容，但不属于当前里程碑的安装和验收范围。

安装并验证 EditorPlugin：

```powershell
node packages/cli/dist/bin.js addon-install examples/control-ui
node packages/cli/dist/bin.js editor-launch examples/control-ui
node packages/cli/dist/bin.js editor-status examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js editor-batch examples/control-ui <RUN_ID> --project-fingerprint <HASH> --scene res://main.tscn --operations '[{"op":"node_create","parentPath":"/root/Main","type":"Button","name":"AgentButton","properties":{"text":"Start"}}]' --confirm-destructive false
node packages/cli/dist/bin.js editor-tree examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js editor-node-create examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --parent /root/Main --type Button --name AgentButton --properties '{"text":"Start"}'
node packages/cli/dist/bin.js editor-node-update examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --node /root/Main/AgentButton --properties '{"position":{"$type":"Vector2","x":32,"y":288}}'
node packages/cli/dist/bin.js editor-node-move examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --node /root/Main/AgentButton --parent /root/Main/Panel
node packages/cli/dist/bin.js editor-scene-instantiate examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --parent /root/Main --scene res://badge.tscn --name AgentBadge
node packages/cli/dist/bin.js editor-scene-inherit examples/physics-2d <RUN_ID> --source res://main.tscn --target res://variants/player_test.tscn --root-name PlayerTest --root-properties '{"scenario_name":"player-test"}'
node packages/cli/dist/bin.js editor-resource-create examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --node /root/Main/Panel/AgentButton --property theme_override_styles/normal --type StyleBoxFlat --properties '{"bg_color":{"$type":"Color","r":0.1,"g":0.35,"b":0.8,"a":1}}'
node packages/cli/dist/bin.js editor-resource-save examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --node /root/Main/Panel/AgentButton --property theme_override_styles/normal --path res://agent_button_style.tres
node packages/cli/dist/bin.js editor-resource-focus examples/control-ui <RUN_ID> --path res://agent_button_style.tres
node packages/cli/dist/bin.js editor-selection-set examples/control-ui <RUN_ID> --paths '["/root/Main/Panel/AgentButton"]'
node packages/cli/dist/bin.js editor-signal-connect examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-project-fingerprint <HASH> --source /root/Main/AgentButton --signal pressed --target /root/Main --method _on_start_pressed
node packages/cli/dist/bin.js editor-undo examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-history-version <N> --expected-action <NAME>
node packages/cli/dist/bin.js editor-redo examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-history-version <N> --expected-action <NAME>
node packages/cli/dist/bin.js editor-save examples/control-ui <RUN_ID> --expected-scene res://main.tscn --expected-history-version <N>
node packages/cli/dist/bin.js editor-screenshot examples/physics-3d <RUN_ID> --viewport 3d --viewport-index 0
node packages/cli/dist/bin.js stop examples/control-ui <RUN_ID>
```

## 验证

`pnpm run test` 会先构建所有 workspace 包，因此在清理构建产物或全新检出后也可独立执行。

```powershell
pnpm run typecheck
pnpm run test
pnpm run verify:npm
pnpm run benchmark:milestone-1
pnpm run benchmark:milestone-2
pnpm run benchmark:milestone-3
pnpm run benchmark:milestone-4
pnpm run benchmark:milestone-5
pnpm run benchmark:runtime
```

存在 `config/development.local.json` 时，测试会真实启动配置的 Godot，覆盖 headless 导入、受管进程、Runtime Bridge 场景树/节点观察、2D/3D 物理仿真、Camera3D 投影与射线、组合输入、等待、暂停和 process/physics 帧推进闭环，以及 EditorPlugin 的 guarded 场景编辑、typed batch、项目设置/InputMap、资源、原生 Undo/Redo、显式保存和证据截图。安全边界见 [docs/security.md](docs/security.md)。核心仍不提供云同步、账号、AI 资产生成、任意脚本探针或发布平台；`addons/godot_agent_runtime/` 和示例项目分别由各自目录内的 MIT License 覆盖，TypeScript/JavaScript 核心、CLI 与 MCP Server 继续采用 AGPL-3.0-or-later。复制进用户项目的 addon 不会把该游戏置于 AGPL 下，npm 中的核心程序仍作为独立工具运行。
