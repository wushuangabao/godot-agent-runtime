# 路线图

当前进度（2026-08-16）：里程碑 1、2、3 均已通过统一真实 Godot 验收；阶段 1 已完成；阶段 2 已完成插件安装、受管连接、场景树/属性读取、节点增删改与移动、PackedScene 实例化与 Editable Children、场景继承、Resource 子属性读写及内置/外部保存、信号连接、选择/聚焦、原生 Undo/Redo、场景保存、2D/3D 视口截图和编辑器相机元数据，以及常用 2D/3D 数学 Variant 的写入纵切；阶段 3 已完成截图、运行时场景树/节点属性观察、面向游戏状态的批量观察、Camera3D 世界坐标投影与屏幕物理射线、UI 发现、单次与组合输入、结构化断言、有界条件等待、暂停后有限 process/physics 帧推进，以及独立 2D/3D World 中的有界物理采样。阶段 4 按当前本机条件收敛为 Codex 与 DeepSeek Harness，不要求安装 Claude Code；项目级配置、共享配方、DSH Headless 启动器、双客户端基准契约及无凭据 MCP 启动验收已经完成，下一项是使用用户自有 DSH 模型凭据执行真实 Headless 闭环并与 Codex 结果对比。

首个里程碑见 [AGENTS.md](../AGENTS.md)。三个基础闭环稳定后，再扩展动画、TileMap、导航、性能分析和更复杂的自动游玩能力。

统一验收命令为 `pnpm run benchmark:milestone-1`：它在临时项目中读取场景，通过 EditorPlugin 修改按钮文案并保存，要求 Godot 重新解析成功，然后启动修改后的游戏，保存交互前后截图，按新文案发现并点击按钮，等待运行状态变化并验证 Label 文本。报告、场景副本和截图统一归档到 `artifacts/milestone-1/<时间戳>/`，临时项目及两类受管进程在成功或失败路径都会清理。

里程碑 2 的统一验收命令为 `pnpm run benchmark:milestone-2`：它通过 EditorPlugin 创建带根节点覆盖的真实继承场景，要求 Godot 重新解析并启动该场景；随后批量观察 CharacterBody2D 状态，在私有 World2D/World3D 中复制当前场景、注入动作并逐物理帧采样，证明模拟副本移动而真实运行树位置不变；最后向真实游戏注入同一动作，用等待、断言、前后观察和截图证明 Player 实际移动。继承场景、逐帧样本、结构化报告和截图归档到 `artifacts/milestone-2/<时间戳>/`，临时项目与进程在成功或失败路径都会清理。

里程碑 3 的统一验收命令为 `pnpm run benchmark:milestone-3`：它通过 EditorPlugin 读取和修改 CharacterBody3D 的 Node3D 变换，保存后捕获指定 3D 编辑器视口及其活动相机；随后启动真实 3D 游戏，把 Player 世界坐标投影为截图像素并从该像素发射物理射线证明命中，通过私有 World3D 仿真证明副本移动且真实状态不变，最后注入真实动作并以接地状态、结构化断言、再次投影/射线和变化后的截图证明完整闭环。场景副本、编辑器/运行时截图、逐帧样本和结构化报告归档到 `artifacts/milestone-3/<时间戳>/`。

## 阶段 0：参考实现审计与协议设计

目标：先复用成熟思路，避免再造一个能力重叠但不完整的 Godot MCP。

- 深入审计参考实现，见 [comparisons.md](comparisons.md)。
- 建立能力矩阵、许可证清单和可复用/不可复用代码边界。
- 决定首版约 15–25 个高层 MCP 工具及稳定 JSON Schema。
- 建立三个基准项目：最小 2D、最小 3D、Control UI。

完成标准：工具协议文档通过评审，三个基准任务可以明确映射到工具调用序列。

## 阶段 1：Headless MVP

目标：不安装 Godot 插件也能完成基础代码迭代。

- 创建 TypeScript MCP Server 和 CLI 骨架。
- 自动发现 Godot 可执行文件和项目。
- 实现项目读取、文本修改、静态检查、运行/停止和控制台采集。
- 实现 `doctor` 命令，诊断 Godot、Node、端口和客户端配置。
- 为 Codex 提供一键 MCP 配置，并保留其他客户端的标准 MCP 扩展能力。

完成标准：Agent 能创建一个最小 Godot 项目、修复 GDScript 错误并成功启动场景。

## 阶段 2：实时编辑器控制

目标：让 Agent 通过 Godot 原生 API 修改正在打开的项目。

- 实现 GDScript `EditorPlugin` 和本机通信桥。
- 实现场景树读取、节点增删改、属性设置、资源创建、信号连接和场景保存。
- 接入 Godot 原生 Undo/Redo。
- 增加 2D/3D 编辑器视口截图、3D 活动相机、选择节点和聚焦资源等辅助能力。
- 对常见 Godot 类型提供稳定序列化：`Vector2/3`、`Color`、`Transform`、`Resource`。

完成标准：Agent 无需直接编辑 `.tscn`，即可构建并保存一个可运行的 2D 与 3D 场景。

## 阶段 3：运行时闭环

目标：Agent 可以像玩家一样检查自己的修改。

- 实现临时 Runtime Bridge 或调试器协议桥接。
- 支持游戏截图、运行时场景树、UI 发现、结构化状态观察、Camera3D 坐标投影和屏幕物理射线。
- 支持动作、键鼠、手柄和时间序列输入。
- 支持冻结、单步、等待条件以及验证探针。
- 把编译错误、运行错误、截图和断言结果整理成紧凑响应。

完成标准：Agent 能自动启动示例游戏、点击开始按钮、移动角色，并用结构化断言证明状态发生了预期变化。

## 阶段 4：Codex / DeepSeek Harness 深度适配

目标：同一核心能力在不同 Agent 中都容易安装、容易理解、表现稳定。

- CLI 提供 `configure codex` 与 `configure deepseek-harness`；既有 Claude Code 目标仅作向后兼容，不进入本阶段验收。
- 为 Codex 和 DSH 提供精简、共享的项目操作配方，避免维护两套含义漂移的提示词。
- 两个本机客户端统一使用 stdio；未来远程场景再评估 Streamable HTTP。
- 为只读工具和修改工具提供清晰的权限分组。
- 编写高质量任务配方：建场景、修错误、实现 UI、自动游玩、性能定位。
- 建立跨 Agent 基准测试，记录成功率、工具调用数、耗时和上下文消耗。
- 使用 DSH Headless Profile 作为基准测试宿主，并验证至少一个 Code Mode 闭环任务：启动游戏、发现 UI、注入输入、截图并完成结构化断言。

完成标准：Codex 与 DeepSeek Harness 在同一组基准任务上均可独立完成闭环，且无需用户搬运日志或截图；DSH 适配失败不得影响核心 MCP Server 和 Codex。

## 阶段 5：稳定化与发布

目标：从可用原型变成可长期维护的开源工具。

- 覆盖 Windows、macOS、Linux 和 Godot 当前两个稳定小版本。
- 增加协议版本协商、插件/服务版本不匹配提示和故障恢复。
- 完成单元测试、Godot headless 集成测试和端到端 Agent 基准。
- 发布 npm 包、插件 ZIP、Godot Asset Library 包和迁移文档。
- 建立贡献指南、工具兼容策略和安全说明。

完成标准：新用户可在十分钟内完成安装，并让 Codex 或 DeepSeek Harness 控制示例项目完成一次自动验证。
