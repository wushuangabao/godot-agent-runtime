# Godot Agent Runtime

Godot Agent Runtime 是面向外部编码 Agent 的本地 Godot 4.x 自动化与自验证层。首个可重复闭环现已可用：安全修改项目文本、静态检查、受管启动/停止、运行时截图、UI 发现、输入注入，以及带 expected/actual/evidence 的结构化交互断言。所有能力通过 stdio MCP 暴露，也提供可组合 CLI。

实时 `EditorPlugin` 已提供安装、受管启动、场景树和属性读取、节点增删改与移动、PackedScene 实例化与 Editable Children、Resource 子属性读写及内置/外部保存、文件系统选择与资源聚焦、信号连接、原生 Undo/Redo、场景保存和 2D 视口截图。Runtime Bridge 通过 Godot `--script` 临时主循环启动，支持有界运行时场景树和节点属性观察，且不改写目标项目的 `project.godot`、退出后不残留 autoload。

首个里程碑可通过 `pnpm run benchmark:milestone-1` 一键验收。脚本使用临时项目，通过 EditorPlugin 修改并保存 UI，再启动 Runtime Bridge 完成截图、UI 发现、点击、等待和结构化断言；证据包写入被 Git 忽略的 `artifacts/milestone-1/<时间戳>/`。

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
node packages/cli/dist/bin.js input-sequence examples/control-ui <RUN_ID> --steps '[{"kind":"click","path":"/root/Main/StartButton","afterMs":20},{"kind":"key","keycode":65,"holdMs":10}]'
node packages/cli/dist/bin.js screenshot examples/control-ui <RUN_ID>
```

`run` 是有限帧 headless 验证，会自动退出；`launch` 打开可见窗口并返回 `runId`，后续由 `status` 查询、由 `stop` 幂等停止。所有命令向标准输出写入 JSON。失败包含稳定的 `code`、`stage`、`message`、`details` 和 `recovery`。

## MCP Server

```powershell
pnpm run mcp
```

stdio 的标准输出只承载 MCP JSON-RPC；服务端诊断写入标准错误。当前工具及契约见 [docs/tool-contracts.md](docs/tool-contracts.md)。

为当前项目生成客户端配置：

```powershell
node packages/cli/dist/bin.js configure codex
node packages/cli/dist/bin.js configure claude-code
```

Codex 配置写入项目级 `.codex/config.toml` 的受管区段；Claude Code 配置合并到 `.mcp.json`，不会删除其他 MCP Server。

安装并验证 EditorPlugin：

```powershell
node packages/cli/dist/bin.js addon-install examples/control-ui
node packages/cli/dist/bin.js editor-launch examples/control-ui
node packages/cli/dist/bin.js editor-tree examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js editor-node-create examples/control-ui <RUN_ID> --parent /root/Main --type Button --name AgentButton --properties '{"text":"Start"}'
node packages/cli/dist/bin.js editor-node-update examples/control-ui <RUN_ID> --node /root/Main/AgentButton --properties '{"position":{"$type":"Vector2","x":32,"y":288}}'
node packages/cli/dist/bin.js editor-node-move examples/control-ui <RUN_ID> --node /root/Main/AgentButton --parent /root/Main/Panel
node packages/cli/dist/bin.js editor-scene-instantiate examples/control-ui <RUN_ID> --parent /root/Main --scene res://badge.tscn --name AgentBadge
node packages/cli/dist/bin.js editor-resource-create examples/control-ui <RUN_ID> --node /root/Main/Panel/AgentButton --property theme_override_styles/normal --type StyleBoxFlat --properties '{"bg_color":{"$type":"Color","r":0.1,"g":0.35,"b":0.8,"a":1}}'
node packages/cli/dist/bin.js editor-resource-save examples/control-ui <RUN_ID> --node /root/Main/Panel/AgentButton --property theme_override_styles/normal --path res://agent_button_style.tres
node packages/cli/dist/bin.js editor-resource-focus examples/control-ui <RUN_ID> --path res://agent_button_style.tres
node packages/cli/dist/bin.js editor-selection-set examples/control-ui <RUN_ID> --paths '["/root/Main/Panel/AgentButton"]'
node packages/cli/dist/bin.js editor-signal-connect examples/control-ui <RUN_ID> --source /root/Main/AgentButton --signal pressed --target /root/Main --method _on_start_pressed
node packages/cli/dist/bin.js editor-undo examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js editor-redo examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js editor-save examples/control-ui <RUN_ID>
node packages/cli/dist/bin.js stop examples/control-ui <RUN_ID>
```

## 验证

`pnpm run test` 会先构建所有 workspace 包，因此在清理构建产物或全新检出后也可独立执行。

```powershell
pnpm run typecheck
pnpm run test
pnpm run benchmark:milestone-1
pnpm run benchmark:runtime
```

存在 `config/development.local.json` 时，测试会真实启动配置的 Godot，覆盖 headless 导入、受管进程、Runtime Bridge 场景树/节点观察、组合输入、等待、暂停和 process/physics 帧推进闭环，以及 EditorPlugin 节点编辑/移动、场景实例及 Editable Children、Resource 子属性与内置/外部保存、选择聚焦、原生撤销/重做、信号连接、保存和截图。安全边界见 [docs/security.md](docs/security.md)。示例项目独立采用 MIT License，核心代码采用 AGPL-3.0-or-later。
