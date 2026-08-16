# Godot Agent Runtime — 项目说明与协作约定

面向 Codex、Claude Code、Cursor 等外部编码 Agent 的开源 Godot 自动化与自验证层。不把聊天窗口塞进 Godot，也不做 AI IDE；目标是让成熟的编码 Agent 可靠地看见、修改、运行、操作并验证标准 Godot 项目：

```text
理解项目 → 修改代码/场景 → 静态检查 → 启动游戏
→ 截图与读取运行状态 → 注入输入 → 判断结果 → 继续修正
```

首要用户是已经使用编码 Agent 的开发者。设计优先考虑工具调用质量、上下文效率、错误可恢复性和自动验证能力。

## 核心原则

1. **Agent 优先**：用 MCP、CLI、项目说明和技能包适配外部工具。
2. **原版 Godot 4.x**：不维护 C++ fork；仅在公共 API 无法实现关键能力时，才用自定义模块打补丁。
3. **验证重于生成**：核心价值是运行游戏、观察真实结果并验证交互。
4. **结构化接口优先**：返回场景树、属性、诊断、运行状态；截图仅在视觉判断必要时使用。
5. **低上下文成本**：工具、参数和返回值便于模型理解，避免重复定义和无关日志。
6. **本地优先**：核心不依赖账号、云服务或托管后端。
7. **渐进增强**：无插件时提供文件级和 headless 能力；装插件后增加实时编辑器与运行时能力。
8. **Code Mode 友好**：稳定 Schema、结构化结果、明确错误码、可组合原子操作；核心不做通用代码执行沙箱。

## 明确不做

- 不开发 Godot 编辑器内聊天 UI。
- 不训练、托管或代理大语言模型。
- 不建设账号、计费、云同步、云资产库或 AI 资产生成平台。
- 不实现独立的复杂事务框架；编辑器修改优先复用 Godot 的 `EditorUndoRedoManager`，项目级恢复交给 Git。
- 不要求使用定制 Godot 二进制。
- 不绑定某一家模型提供商或某一个编码 Agent。

## 架构与范围

Agent 经 stdio 或 Streamable HTTP 调用 TypeScript MCP Server + CLI；再经本机 WebSocket/TCP 连接 Godot `EditorPlugin`，并可选接入临时 Runtime Bridge。分层职责、技术栈和仓库结构见 [docs/architecture.md](docs/architecture.md)。

第一版工具围绕任务闭环（项目诊断、场景与资源、文件与代码、运行时观察与交互），不机械映射 Godot 的每个 API。DeepSeek Harness 是可选客户端和基准宿主，不是核心依赖。工具边界、Code Mode 契约与 DSH 决策见 [docs/tool-contracts.md](docs/tool-contracts.md)。

## 首个里程碑

不是生成完整游戏，而是可重复演示：用户描述简单 UI 修改 → Agent 读取项目与场景 → 创建或修改 UI 节点和脚本 → Godot 解析并启动 → 截图、发现按钮并模拟点击 → 读取运行状态并返回结构化断言成功。
闭环稳定后再扩展。阶段计划见 [docs/roadmap.md](docs/roadmap.md)。

## 贡献要点

开始前阅读本文件和相关设计文档。
优先小而可验证的改动；不要在没有基准或失败案例时大规模重写工具协议。
新工具须说明使用场景、读写属性、Schema、成功/失败响应和验证方式。
错误须含稳定错误码、阶段和可执行恢复建议。
新增编辑器能力前先确认标准 Godot API；新增运行时能力必须有端到端测试。
不把模型 API、密钥或某家 Agent SDK 放进核心协议。
复用外部代码须核对许可证。
默认向后兼容。

完整规则见 [docs/contributing.md](docs/contributing.md)；参考实现见 [docs/comparisons.md](docs/comparisons.md)。
