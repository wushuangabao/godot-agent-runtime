# 架构

外部编码 Agent 通过 MCP 调用本项目；本项目再控制标准 Godot 4.x 编辑器与可选运行时桥。

```text
Codex / DeepSeek Harness / 其他标准 MCP 客户端
                    │
                    │ stdio 或 Streamable HTTP
                    ▼
          TypeScript MCP Server + CLI
          ├─ Core 单源 playbook / task recipes
          ├─ 项目发现与 headless 操作
          ├─ Godot 进程管理与诊断
          ├─ 工具协议和响应压缩
          └─ 客户端配置/技能安装
                    │
                    │ 本机 WebSocket/TCP
                    ▼
             Godot EditorPlugin
          ├─ 场景树和 Inspector 操作
          ├─ 编辑器状态与 Undo/Redo
          ├─ 运行、停止和错误采集
          └─ 调试器/运行实例桥接
                    │
                    ▼
          可选的临时 Runtime Bridge
          ├─ 游戏截图与 3D 空间查询
          ├─ 输入注入
          ├─ 运行时场景树/状态读取
          └─ 测试探针与确定性推进
```

## 当前桥接实现

- Agent guidance 是 Core 中静态、只读、无状态的数据。MCP 的 `godot_agent_guide` 与 CLI 的 `agent-guide` 只调用 `getAgentGuide()`；MCP Resource/Prompt 因客户端发现能力不一致暂不作为首版入口。guidance 不执行命令，也不持有工作流或任务状态。
- 0.2.0 的调用先以 `godot_project_context` 绑定项目；文件写入在实际落盘点校验 project fingerprint 与 create/SHA-256 guard，Editor 持久修改在 Bridge 权威点校验活动 scene/history。多节点编辑是最多 32 项的固定 tagged union，并且只提交一个原生 Undo/Redo action，不透传 raw operation、不隐式保存。
- EditorPlugin 由 `godot_addon_install` 复制到目标项目并显式加入 `editor_plugins/enabled`。只有受管编辑器进程携带端口、令牌和 runId 环境变量时才监听；普通编辑器启动不会开放端口。
- Runtime Bridge 不注册 autoload，也不修改项目配置。受管场景使用 Godot `--script addons/godot_agent_runtime/runtime_entry.gd` 的仓库源文件作为临时 `SceneTree` 主循环，再加载目标场景。
- 两个桥都只监听 `127.0.0.1`，每次运行使用 256 位随机令牌，采用单请求单响应的换行分隔 JSON。请求和响应均限制为 1 MiB；首次握手严格协商协议版本并采用桥接端实际能力列表。
- 桥接没有任意 GDScript/JavaScript 执行命令。命令集合固定为编辑态与运行态结构读取、受校验的节点/属性/Resource 子属性/PackedScene 实例、场景继承及 Editable Children/信号编辑、原生 Undo/Redo、保存、2D/3D 编辑器与游戏截图、Camera3D 世界坐标投影和屏幕物理射线、游戏状态批量观察、受限单次/组合输入、结构化断言、有界等待、暂停后有限 process/physics 帧推进，以及私有 2D/3D World 中的有界场景副本物理采样。
- 截图证据只写入项目 `.godot/agent-runtime/evidence/<runId>/`；MCP 层再次验证返回路径没有逃逸该目录。
- MCP/CLI 包版本与 Bridge transport 版本彼此独立：当前包和 initialize serverInfo 是 `0.2.0`，Editor transport 是 `0.7.0`，Runtime transport 是 `0.4.0`。严格握手按 bridge kind 校验，不用包版本或 deprecated alias 猜测另一类协议。

## 结构化运行时优势与范围

截图只能证明 `editor_viewport` 或 `runtime_frame` 对应的单帧视觉事实，始终 `provesInteraction:false`。交互闭环使用 find/input/wait/assert；2D/3D 观察、确定性推进和隔离 World 物理采样返回可比较的结构化状态，因此无需把像素变化误当作行为证明。

核心保持本地优先和固定命令表，不建设云同步、账号、AI 资产生成、托管发布平台或任意脚本/对象探针。导出、签名、真机部署等高风险工作流另行设计，不隐藏在通用 batch 或 guidance 中。

## 技术栈

- MCP Server/CLI：TypeScript、Node.js 20+、官方 MCP SDK。
- Godot 集成：GDScript `EditorPlugin`，必要时再引入 GDExtension。
- 通信：仅监听 loopback 的 WebSocket 或 TCP，并使用每次会话随机令牌。
- 测试：Vitest 或 Node test runner，加 Godot headless 集成测试和最小示例项目。
- 分发：npm 包负责 MCP Server/CLI；Godot 插件同时提供 release ZIP 和 Asset Library 包。

## 建议的仓库结构

```text
godot-agent-runtime/
├─ AGENTS.md
├─ README.md
├─ LICENSE
├─ package.json
├─ packages/
│  ├─ mcp-server/
│  ├─ cli/
│  ├─ core/
│  └─ protocol/
├─ addons/
│  └─ godot_agent_runtime/
├─ adapters/
│  ├─ codex/
│  ├─ deepseek-harness/
│  └─ agent-recipes.md
├─ examples/
│  ├─ minimal-2d/
│  ├─ minimal-3d/
│  └─ control-ui/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ agent-benchmarks/
│     ├─ codex/
│     └─ deepseek-harness/
└─ docs/
   ├─ architecture.md
   ├─ tool-contracts.md
   ├─ roadmap.md
   ├─ contributing.md
   └─ comparisons.md
```
