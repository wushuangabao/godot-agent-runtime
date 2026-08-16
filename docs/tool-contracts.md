# 工具契约

工具设计应围绕任务闭环组织，而不是机械映射 Godot 的每个 API。项目原则见 [AGENTS.md](../AGENTS.md)。

## 第一版工具边界

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

## DeepSeek Harness 与 Code Mode 集成决策

DeepSeek Harness（DSH）是本项目支持的可选外部客户端和基准测试宿主，不是核心运行时依赖。本项目通过标准 MCP 协议向 DSH 暴露 Godot 能力，不引入 DSH 的模型适配器、Agent Loop、聊天界面、通用会话系统、技能路由、工作流引擎或代码执行沙箱。

### DSH 基准测试宿主

- 在 `adapters/deepseek-harness/` 提供 MCP Client 配置、安装说明和可选的项目级操作说明，CLI 最终提供 `configure deepseek-harness`。
- 在 `tests/agent-benchmarks/deepseek-harness/` 建立可重复的 headless 基准任务，覆盖项目诊断、场景启动、UI 发现、输入注入、截图和结构化断言。
- 同一组任务应同时在 Codex 和 DSH 上执行，记录成功率、模型轮数、工具调用数、耗时、上下文消耗、错误恢复能力和验证证据。Claude Code 不作为当前本机里程碑的前置条件。
- DSH 的事件日志只作为基准与故障分析证据，不演变为本项目自己的聊天或会话系统。
- DSH 处于快速迭代阶段，适配层必须与核心协议隔离，并通过真实安装包和实际 MCP 启动路径测试兼容性。

### 面向 Code Mode 的工具契约

- 每个工具必须提供稳定、严格且可版本化的 `inputSchema`；适用时提供 `outputSchema` 和 MCP `structuredContent`。
- 成功结果应以紧凑 JSON 返回可继续编排的数据；自然语言摘要只能作为辅助，不得成为唯一结果。
- 失败结果必须包含稳定的错误 `code`、发生 `stage`、可读 `message`、必要 `details` 和可执行的恢复建议，跨 MCP Server、EditorPlugin 与 Runtime Bridge 时不得覆盖底层结构化错误。
- 工具应保持职责单一、行为确定、边界明确，并尽可能幂等；耗时操作返回可轮询状态，批量操作必须有数量、时间和输出大小上限。
- 截图、日志和大型场景数据优先返回路径、资源链接、摘要与分页信息，避免把大块二进制或无关日志直接放入模型上下文。
- 对启动、等待、输入、截图和断言等高频闭环，可提供有限的 Godot 专用组合工具；不得因此引入通用 TypeScript/JavaScript 执行器。
- 工具清单必须可查询，并在启动测试中对关键工具和 Schema 做语义断言，不能只依赖快照或“无报错”判断注册成功。

## 已实现的 MVP 工具

所有工具使用严格 Zod Schema，同时返回文本摘要和 MCP `structuredContent`。工具处理失败时返回 `isError: true`，结构化错误包含 `code`、`stage`、`message`、可选 `details` 和至少一条 `recovery`。

| 工具 | 属性 | 输入 | 成功结果 | 验证 |
|---|---|---|---|---|
| `godot_doctor` | 只读、幂等 | 可选 `configPath` | Node、配置、Godot、DSH、loopback 检查列表 | 环境集成测试与 MCP 列表测试 |
| `godot_projects_find` | 只读、幂等、有数量和深度上限 | `searchRoot`、`maxDepth`、`maxProjects` | 项目元数据数组、扫描目录数、截断标志 | 三个示例项目发现测试 |
| `godot_project_inspect` | 只读、幂等 | `projectPath` | 项目名、主场景、渲染器和插件 | `project.godot` 单元测试 |
| `godot_project_check` | 写入项目 `.godot/` 缓存、幂等 | 项目、配置、超时和输出上限 | 导入退出状态、紧凑日志和诊断 | 真实 Godot headless 导入测试 |
| `godot_scene_run` | 启动 headless 本地进程、有限帧、幂等 | 项目、可选场景、配置、超时和输出上限 | 启动退出状态、紧凑日志和诊断 | 真实场景启动标记测试 |
| `godot_scene_launch` | 启动可见持久进程、非幂等 | 项目、可选场景、配置和启动超时 | `runId`、进程标识、命令及日志路径 | 跨进程运行会话集成测试与真实 Godot 验证 |
| `godot_run_status` | 只读、幂等 | 项目、`runId` 和输出上限 | 运行状态、有界日志、诊断及失败信息 | 运行会话集成测试 |
| `godot_run_stop` | 停止本地进程、幂等 | 项目、`runId`、停止超时和输出上限 | 最终运行状态、有界日志和诊断 | 首次停止与重复停止测试 |
| `godot_file_read` | 只读、幂等、项目内、1 MiB 上限 | 项目、`res://`/相对路径、可选上限 | UTF-8 内容、字节数、SHA-256 | 路径逃逸、类型和读取测试 |
| `godot_file_write` | 原子写、项目内、乐观锁 | 项目、路径、内容、可选 `expectedSha256` | created/updated、前后 SHA-256 | 冲突、类型、嵌套创建测试 |
| `godot_addon_install` | 项目写入、幂等 | 项目 | 插件文件与配置变更标志 | 保留已有插件并重复安装 |
| `godot_runtime_status` | 只读、幂等 | 项目、`runId` | 引擎、场景和能力协商 | 真实桥接握手 |
| `godot_runtime_screenshot` | 写入运行证据 | 项目、`runId`、超时 | PNG 路径、尺寸、字节数、SHA-256 | 真实视口截图与路径约束 |
| `godot_runtime_ui_find` | 只读、幂等、最多 500 项 | 项目、`runId`、selector、limit | Control 路径、类型、文本、状态和矩形 | Control UI 发现测试 |
| `godot_runtime_scene_tree` | 只读、幂等、最大 64 层/5000 节点 | 项目、`runId`、深度和节点上限 | 当前场景结构树与截断标志 | 真实运行场景树测试 |
| `godot_runtime_node_get` | 只读、幂等、最多 100 个属性 | 节点路径、属性名 | 节点身份、父路径、源场景和序列化属性 | Label 属性及缺失属性测试 |
| `godot_runtime_observe` | 只读、幂等、最多 32 个节点/32 个附加属性 | 节点路径数组、可选属性名 | 常用位置/速度/动画/可见性、CharacterBody 接触状态、分组、元数据和附加属性 | Control 与 CharacterBody2D 批量观察测试 |
| `godot_runtime_simulate_physics` | 执行场景脚本、非幂等、最多 5000 节点/120 帧 | 节点、属性、帧数、可选 InputMap action | 私有 World2D/World3D 中场景副本的逐帧样本及暂停恢复状态 | 副本移动且真实 Player 位置不变测试 |
| `godot_runtime_3d_project` | 只读、幂等 | 可选 Camera3D、Node3D 或世界坐标 | 屏幕像素、视口尺寸、深度、距离及可见性 | Player 世界坐标投影到真实 3D 截图测试 |
| `godot_runtime_3d_raycast` | 只读、幂等、最大距离 100000 | 屏幕像素、可选 Camera3D、距离、碰撞层与 body/area 开关 | 射线、命中碰撞体路径、位置、法线和 shape | 投影像素反向命中 CharacterBody3D 测试 |
| `godot_runtime_input` | 非幂等、输入最长 2 秒 | click/action/key 的受限参数 | 投递状态、目标和坐标 | 点击按钮并观察状态变化 |
| `godot_runtime_input_sequence` | 非幂等、最多 32 步/5 秒 | click/action/key 步骤及步后延迟 | 每步投递结果和总耗时 | 点击+按键组合测试 |
| `godot_runtime_assert` | 只读、幂等 | UI 存在或属性比较谓词 | `passed/expected/actual/evidence` | meta 与 Label 文本断言 |
| `godot_runtime_wait` | 只读、有界等待 | UI/属性谓词、最长 30 秒、轮询帧间隔 | satisfied/timedOut、次数、末次观察 | 成功与超时路径测试 |
| `godot_runtime_control` | 非幂等、有限推进 | pause/resume，或暂停后 1–120 个 process/physics 帧 | 暂停状态与两类实际推进帧数 | 两类 2 帧推进测试 |
| `godot_editor_launch` | 启动可见编辑器、非幂等 | 项目、配置、超时 | 受管 `runId` 与日志 | 真实 EditorPlugin 启动 |
| `godot_editor_status` | 只读、幂等 | 项目、`runId` | 编辑场景与插件能力 | 插件握手测试 |
| `godot_editor_scene_tree` | 只读、幂等、最大 64 层 | 项目、`runId` | 编辑场景结构树 | Control UI 场景树测试 |
| `godot_editor_node_get` | 只读、幂等、最多 100 个属性 | 节点路径、属性名 | 节点描述与 tagged Variant | Vector2/文本读取测试 |
| `godot_editor_node_create` | 写入、非幂等、原生 Undo/Redo | 父路径、类型、名称、属性 | 新节点、变更属性 | 创建后读取并删除 |
| `godot_editor_scene_instantiate` | 写入、非幂等、原生 Undo/Redo | 父路径、`.tscn`、名称和覆盖属性 | 实例节点与源场景 | 实例化后撤销/重做并运行 |
| `godot_editor_scene_create_inherited` | 创建/可选覆盖 `.tscn`，文件不可撤销 | 源场景、目标场景、根名称/属性、打开/覆盖标志 | 继承源、目标、摘要和 SHA-256 | 原生继承序列化、覆盖拒绝及派生场景运行测试 |
| `godot_editor_instance_get` / `godot_editor_instance_set_editable` | 读取或修改 PackedScene Editable Children | 实例根路径、editable 标志 | 源场景、新旧状态 | 切换后撤销/重做并保存 |
| `godot_editor_node_update` | 写入、非幂等、原生 Undo/Redo | 节点路径、新名称/属性 | 新旧路径与变更属性 | 修改、撤销、重做测试 |
| `godot_editor_node_delete` | 写入、非幂等、可撤销 | 非根节点路径 | 被删除节点描述 | 临时节点删除测试 |
| `godot_editor_node_move` | 写入、非幂等、可撤销 | 节点、新父节点、索引、保留全局变换 | 新旧父路径和索引 | 重挂后撤销/重做测试 |
| `godot_editor_resource_create` | 写入、非幂等、可撤销 | 节点属性、Resource 类型和属性 | 内置 Resource 描述 | StyleBoxFlat 保存测试 |
| `godot_editor_resource_get` / `godot_editor_resource_update` | 最多 100 个子属性；更新可撤销 | 节点 Resource 属性、子属性名/值 | Resource 描述和变更属性 | Color 更新、撤销与重做 |
| `godot_editor_resource_save` | 创建/可选覆盖 `.tres`，文件不可撤销 | Resource 属性、目标路径、覆盖标志 | SHA-256、大小和引用恢复属性 | 默认拒绝覆盖，ExtResource 保存 |
| `godot_editor_resource_focus` | 改变瞬时编辑器状态 | 项目资源路径 | FileSystem 选择与资源类型 | 外部 StyleBoxFlat 聚焦 |
| `godot_editor_selection_get` / `godot_editor_selection_set` | 读取或替换瞬时编辑器状态 | 最多 100 个节点路径、聚焦标志 | 选中和聚焦路径 | Inspector 聚焦回读测试 |
| `godot_editor_signal_connect` | 写入、非幂等、持久连接 | 源/信号/目标/方法 | 连接描述 | 保存后运行时点击测试 |
| `godot_editor_scene_save` | 写入、幂等 | 项目、`runId` | 保存状态与 `res://` 路径 | 保存文件内容检查 |
| `godot_editor_undo` / `godot_editor_redo` | 写入、非幂等 | 项目、`runId` | 动作名与历史版本 | 实际回退并恢复属性 |
| `godot_editor_screenshot` | 写入编辑器证据并切换主屏 | 项目、`runId`、`2d/3d`、3D 视口索引 0–3、超时 | PNG、视口及活动 3D 编辑器相机元数据 | 真实 2D/3D 编辑器截图测试 |

`godot_scene_run` 用于自动验证，不创建窗口，并在有限帧后自动退出。`godot_scene_launch` 用于人工观察或后续运行时交互：它创建可见窗口并返回 `runId`，调用方不应等待进程退出，而应使用 `godot_run_status` 和 `godot_run_stop` 管理生命周期。

`godot_project_check`、`godot_scene_run` 与 `godot_scene_launch` 将 Godot 的宿主配置和缓存隔离到项目 `.godot/agent-runtime-host/`，不读写用户的 Godot 编辑器设置。持久运行元数据和有界日志位于项目 `.godot/agent-runtime/runs/`；停止请求使用每次运行随机生成、仅保存在元数据中的令牌，避免对后来复用同一 PID 的无关进程直接发信号。进程输出默认限制为 64 KiB；MCP 参数最多允许 1 MiB，超时最多 120 秒。桥接响应超过 1 MiB 时返回 `RUNTIME_RESPONSE_TOO_LARGE` 或 `EDITOR_RESPONSE_TOO_LARGE`，不会静默丢弃响应并让调用方超时。

运行时与编辑器桥接共用 loopback、随机令牌和 `runId`，但能力表彼此独立。握手严格验证 `protocolVersion` 并采用桥接实际返回的已知能力列表，不兼容时快速失败。两个桥都是固定命令表，不提供动态脚本执行。Runtime Bridge 的等待最长 30 秒，场景树最多 64 层/5000 节点，节点读取最多 100 个已声明属性，批量观察最多 32 个节点和 32 个附加属性；3D 投影只读取 Node3D/Camera3D 变换，3D 射线只查询当前 World3D 且距离不超过 100000。结构化属性断言在统一的有界 JSON 表示上比较，避免 Variant 与 JSON 表示不一致。输入序列最多 32 步/5 秒，单次推进最多 120 个 process 或 physics 帧且必须先暂停。输入注入、隔离模拟和暂停/推进控制共享排他执行区，并携带客户端超时；排队或执行中的请求在截止或断连后取消并清理输入/暂停状态。隔离物理采样最多复制 5000 个节点并推进 120 帧，使用 SubViewport 的独立 World2D/World3D；采样期间禁用真实场景节点处理并停用真实物理空间，让全局物理帧只推进副本世界，结束后恢复真实物理空间、节点处理模式、SceneTree 暂停状态及模拟前 Input action 强度。副本脚本仍会执行，因此它不是不可信代码沙箱。EditorPlugin 场景写操作及 Resource 子属性更新进入 Godot 原生 Undo/Redo；继承场景和外部 `.tres` 文件创建不可由场景历史删除，均默认拒绝覆盖。所有 Resource 引用路径都经过项目边界和链接检查。选择/聚焦是非持久编辑器状态；截图会切换到请求的 2D 或 3D 主屏。完整边界见 [security.md](security.md)。
