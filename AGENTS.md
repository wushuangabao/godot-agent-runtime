# Godot Agent Runtime — 项目说明与协作约定

## 项目愿景

Godot Agent Runtime 是一个面向 Codex、Claude Code 等外部编码 Agent 的开源 Godot 自动化与自验证层。

项目不试图把聊天窗口塞进 Godot，也不重新实现一个 AI IDE。它要做的是让成熟的编码 Agent 能够可靠地“看见、修改、运行、操作并验证”标准 Godot 项目，从而形成完整闭环：

```text
理解项目 → 修改代码/场景 → 静态检查 → 启动游戏
→ 截图与读取运行状态 → 注入输入 → 判断结果 → 继续修正
```

首要用户是已经使用 Codex、Claude Code、Cursor 或其他 Coding AI Agent 工具的开发者。所有设计都优先考虑工具调用质量、上下文效率、错误可恢复性和自动验证能力。

## 核心原则

1. **Agent 优先**：通过 MCP、CLI、项目说明和技能包适配 Codex、Claude Code 等工具。
2. **使用原版 Godot**：基于标准 Godot 4.x，不维护 Godot C++ fork。只有经过原型验证、确认公共 API 无法实现关键能力时，才使用“自定义 C++ 模块”给引擎打补丁。
3. **验证重于生成**：能写文件只是起点；核心价值是 Agent 能运行游戏、观察真实结果并验证交互行为。
4. **结构化接口优先**：尽量返回场景树、属性、诊断、运行状态等结构化数据；只在视觉判断确有必要时使用截图。
5. **低上下文成本**：工具数量、参数和返回值应便于模型理解，避免把大量重复定义和无关日志塞进上下文。
6. **本地优先**：核心功能不依赖账号、云服务或托管后端；用户自己的模型与编码 Agent 负责推理。
7. **渐进增强**：无插件时提供文件级和 headless 能力；安装 Godot 插件后增加实时编辑器与运行时能力。

## 明确不做的事情

- 不开发 Godot 编辑器内聊天 UI。
- 不训练、托管或代理大语言模型。
- 不建设账号、计费、云同步、云资产库或 AI 资产生成平台。
- 不实现独立的复杂事务框架；编辑器修改优先复用 Godot 的 `EditorUndoRedoManager`，项目级恢复交给 Git。
- 不要求使用定制 Godot 二进制。
- 不绑定某一家模型提供商或某一个编码 Agent。

## 目标架构

```text
Codex / Claude Code / Cursor / 其他 AI Coding 工具
                    │
                    │ stdio 或 Streamable HTTP
                    ▼
          TypeScript MCP Server + CLI
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
          ├─ 游戏截图
          ├─ 输入注入
          ├─ 运行时场景树/状态读取
          └─ 测试探针与确定性推进
```

建议技术栈：

- MCP Server/CLI：TypeScript、Node.js 20+、官方 MCP SDK。
- Godot 集成：GDScript `EditorPlugin`，必要时再引入 GDExtension。
- 通信：仅监听 loopback 的 WebSocket 或 TCP，并使用每次会话随机令牌。
- 测试：Vitest 或 Node test runner，加 Godot headless 集成测试和最小示例项目。
- 分发：npm 包负责 MCP Server/CLI；Godot 插件同时提供 release ZIP 和 Asset Library 包。

## 第一版工具边界

工具设计应围绕任务闭环组织，而不是机械映射 Godot 的每个 API。

### 项目与诊断

- 获取 Godot 版本、项目路径、主场景、渲染器和插件状态。
- 获取 GDScript/C# 静态错误、编辑器错误、运行时错误和精简控制台输出。
- 启动、停止、重启主场景或指定场景。

### 场景与资源

- 读取场景树、节点类型、节点属性和信号连接。
- 创建、删除、移动、重命名节点。
- 设置节点属性，创建并设置常见 Resource。
- 实例化场景，连接信号，保存场景。
- 支持成组操作，但不另造事务系统；实时编辑器操作使用 Godot 原生 Undo/Redo。

### 文件与代码

- 读取、创建和修改 `.gd`、`.cs`、`.tscn`、`.tres`、`project.godot` 等项目文件。
- 修改后触发 Godot 重新扫描，并返回明确的解析/编译结果。
- 避免让 Agent 手工猜测二进制编码或 Godot 内部序列化字段；这些内容由插件操作。

### 运行时观察与交互

- 捕获运行游戏截图。
- 注入 InputMap action、键盘、鼠标和手柄输入。
- 查询可见 UI、运行时节点、位置、速度、动画和自定义观察状态。
- 支持分帧推进、等待条件成立和脚本化验证探针。
- 输出可机器判断的断言结果，而不是只返回自然语言描述。

## 路线图

### 阶段 0：参考实现审计与协议设计

目标：先复用成熟思路，避免再造一个能力重叠但不完整的 Godot MCP。

- 深入审计以下参考实现：
  - `Erodenn/godot-mcp-runtime`：临时 Runtime Bridge、零项目残留。
  - `hi-godot/godot-ai`：广泛的编辑器操作和客户端配置。
  - `satelliteoflove/godot-mcp`：确定性运行时测试与结构化观察。
  - `htdt/godogen`：Agent 工作流、技能和视觉自修复循环。
  - `SummerEngine/summer-engine-agent`：Agent 工具层、技能路由和 Godot 控制接口设计。
- 建立能力矩阵、许可证清单和可复用/不可复用代码边界。
- 决定首版约 15–25 个高层 MCP 工具及稳定 JSON Schema。
- 建立三个基准项目：最小 2D、最小 3D、Control UI。

完成标准：工具协议文档通过评审，三个基准任务可以明确映射到工具调用序列。

### 阶段 1：Headless MVP

目标：不安装 Godot 插件也能完成基础代码迭代。

- 创建 TypeScript MCP Server 和 CLI 骨架。
- 自动发现 Godot 可执行文件和项目。
- 实现项目读取、文本修改、静态检查、运行/停止和控制台采集。
- 实现 `doctor` 命令，诊断 Godot、Node、端口和客户端配置。
- 为 Codex 与 Claude Code 提供一键 MCP 配置。

完成标准：Agent 能创建一个最小 Godot 项目、修复 GDScript 错误并成功启动场景。

### 阶段 2：实时编辑器控制

目标：让 Agent 通过 Godot 原生 API 修改正在打开的项目。

- 实现 GDScript `EditorPlugin` 和本机通信桥。
- 实现场景树读取、节点增删改、属性设置、资源创建、信号连接和场景保存。
- 接入 Godot 原生 Undo/Redo。
- 增加编辑器截图、选择节点和聚焦资源等辅助能力。
- 对常见 Godot 类型提供稳定序列化：`Vector2/3`、`Color`、`Transform`、`Resource`。

完成标准：Agent 无需直接编辑 `.tscn`，即可构建并保存一个可运行的 2D 与 3D 场景。

### 阶段 3：运行时闭环

目标：Agent 可以像玩家一样检查自己的修改。

- 实现临时 Runtime Bridge 或调试器协议桥接。
- 支持游戏截图、运行时场景树、UI 发现和结构化状态观察。
- 支持动作、键鼠、手柄和时间序列输入。
- 支持冻结、单步、等待条件以及验证探针。
- 把编译错误、运行错误、截图和断言结果整理成紧凑响应。

完成标准：Agent 能自动启动示例游戏、点击开始按钮、移动角色，并用结构化断言证明状态发生了预期变化。

### 阶段 4：Codex / Claude Code 深度适配

目标：同一核心能力在不同 Agent 中都容易安装、容易理解、表现稳定。

- CLI 提供 `configure codex`、`configure claude`、`configure cursor` 等适配命令。
- 为 Codex 生成精简 `AGENTS.md`/skills，为 Claude Code 生成 `CLAUDE.md`/skills 和权限建议。
- 根据客户端能力选择 stdio 或 Streamable HTTP。
- 为只读工具和修改工具提供清晰的权限分组。
- 编写高质量任务配方：建场景、修错误、实现 UI、自动游玩、性能定位。
- 建立跨 Agent 基准测试，记录成功率、工具调用数、耗时和上下文消耗。

完成标准：Codex 与 Claude Code 在同一组基准任务上均可独立完成闭环，且无需用户搬运日志或截图。

### 阶段 5：稳定化与发布

目标：从可用原型变成可长期维护的开源工具。

- 覆盖 Windows、macOS、Linux 和 Godot 当前两个稳定小版本。
- 增加协议版本协商、插件/服务版本不匹配提示和故障恢复。
- 完成单元测试、Godot headless 集成测试和端到端 Agent 基准。
- 发布 npm 包、插件 ZIP、Godot Asset Library 包和迁移文档。
- 建立贡献指南、工具兼容策略和安全说明。

完成标准：新用户可在十分钟内完成安装，并让 Codex 或 Claude Code 控制示例项目完成一次自动验证。

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
│  └─ protocol/
├─ addons/
│  └─ godot_agent_runtime/
├─ adapters/
│  ├─ codex/
│  ├─ claude-code/
│  └─ shared-skills/
├─ examples/
│  ├─ minimal-2d/
│  ├─ minimal-3d/
│  └─ control-ui/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ agent-benchmarks/
└─ docs/
   ├─ architecture.md
   ├─ tool-contracts.md
   └─ comparisons.md
```

## 面向贡献 Agent 的工作规则

1. 开始工作前先阅读本文件、相关设计文档和当前 issue。
2. 优先提交小而可验证的改动；不要在没有基准或失败案例时大规模重写工具协议。
3. 新工具必须说明：使用场景、只读/写入属性、参数 Schema、成功响应、失败响应和验证方式。
4. 返回错误时给出结构化错误码、发生阶段和可执行的恢复建议；不要只返回堆栈。
5. 新增编辑器能力前，先确认标准 Godot API 是否可以实现；不得无理由引入定制引擎依赖。
6. 新增运行时能力必须提供端到端测试，证明 Agent 实际观察或改变了运行游戏状态。
7. 不把模型 API、密钥或某家 Agent SDK放进核心协议层。
8. 对外部参考项目的代码复用必须核对许可证并保留必要声明。
9. 默认保持向后兼容；需要破坏协议时更新协议版本与迁移说明。
10. 完成改动后至少运行受影响的单元测试、Godot headless 测试和一个相关基准任务。

## 首个里程碑

第一个里程碑不是“生成一款完整游戏”，而是完成下面这个可重复演示：

1. 用户在 Codex 或 Claude Code 中描述一个简单的 Godot UI 修改。
2. Agent 读取当前项目与场景。
3. Agent 创建或修改 UI 节点和脚本。
4. Godot 完成解析并启动场景。
5. Agent 截取运行画面、发现按钮并模拟点击。
6. Agent 读取点击后的运行状态并返回结构化断言成功。

这个闭环稳定后，再扩展动画、TileMap、导航、3D、性能分析和更复杂的自动游玩能力。

## 外部参考

- Godot 自定义 C++ 模块：https://docs.godotengine.org/zh-cn/4.x/engine_details/engine_api/custom_modules_in_cpp.html
- Godot MCP Runtime：https://github.com/Erodenn/godot-mcp-runtime
- Godot AI：https://github.com/hi-godot/godot-ai
- satelliteoflove/godot-mcp：https://github.com/satelliteoflove/godot-mcp
- Godogen：https://github.com/htdt/godogen
- Summer Engine Agent：https://github.com/SummerEngine/summer-engine-agent
