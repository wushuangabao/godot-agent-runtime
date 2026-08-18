# 安全边界

Godot 项目本身可以执行任意本机代码。本项目的安全目标不是把不可信 Godot 项目变成沙箱，而是避免自动化层额外扩大文件、进程和网络攻击面，并让每次写入与运行都可审计、可停止。

## 安全文本修改

- 只接受项目相对路径或 `res://` 路径；解析后的目标必须仍在项目根目录内。
- 拒绝路径中的符号链接/联接点，不跟随它们逃逸项目。
- 只读写 Godot 脚本、文本资源、场景、配置和文档等白名单后缀；拒绝 NUL 字节和二进制资产。
- 默认最大 1 MiB。写入先落到同目录随机临时文件，再原子重命名。
- 读取返回 SHA-256；写入必须携带 create guard 或 matching SHA-256 guard，无 guard 直接失败。legacy `expectedSha256` 仍兼容相同语义，`null` 表示“仅当文件尚不存在时创建”；stale 更新返回结构化 `FILE_WRITE_CONFLICT`，不会覆盖编辑器或用户刚完成的修改。
- 持久文件写入还可绑定 `godot_project_context` 返回的 project fingerprint。正常本地开发中的并发写入通过同一 mutation lease 串行并在权威落盘点重验；不把同用户恶意进程在最后检查后替换父目录作为当前威胁模型。

## 进程生命周期

- 每次启动生成 UUID runId 和 256 位随机控制令牌；停止请求发送给仍持有该令牌的 supervisor，不直接根据外部 PID 杀进程。
- 状态、控制文件和有界日志位于项目 `.godot/agent-runtime/runs/`。
- 停止先请求 `SIGTERM`，5 秒后仍未退出则升级为 `SIGKILL`；重复停止返回同一个终态。
- Godot 的数据/配置/缓存目录隔离在项目 `.godot/agent-runtime-host/`，不读写用户编辑器的全局设置。

## 诊断、日志与调试报告

- 受管日志读取使用 stdout/stderr 独立原始字节游标；单次合计最多 1 MiB、最多 500 行。组合结果固定为 stdout 块后接 stderr 块，每条记录标明来源，不声称恢复两个文件的真实交错时序。
- 游标只越过完整 UTF-8 code point；过滤、严重级别整形和去重不删除或改写原始日志文件。诊断读取每次最多消费 `maxIssues` 条原始日志行，不让 `nextCursor` 越过本次未返回的不同问题；截断时要求继续调用 `godot_log_read`。诊断建议只依据当前可观察到的运行状态、日志、截断与错误事实；“日志干净”不等于交互验证成功。
- 调试报告先校验项目 fingerprint，再经项目 mutation lease 以 create-only 方式发布到 `.godot/agent-runtime/reports/`。报告总量有界，只汇总 doctor、独立 Editor/Runtime 协议版本、能力、诊断、过滤日志和用户提供的问题/复现说明，不读取项目源码，也不收集环境变量值或完整 MCP 参数。
- 常见 token、密码、secret、API key 和 Bearer 授权值在 Markdown/JSON 报告中统一脱敏；receipt 始终标记 `reviewRequired: true`，调用方发送报告前仍需人工检查。
- MCP 调用诊断日志只写 stderr。默认记录已注册工具的失败（包括 handler 运行前的输入 Schema 校验失败），`GODOT_AGENT_RUNTIME_MCP_DEBUG=1` 时记录其全部调用；每条 JSON 仅含 `tool/ok/durationMs/code/stage`，不记录参数、令牌或项目内容，stdout 始终保留给 MCP 协议帧。未知工具名由 MCP SDK 在匹配已注册工具前拒绝，不属于这项调用日志契约。

## EditorPlugin 与 Runtime Bridge

- 只绑定 `127.0.0.1`，端口由操作系统临时分配；不监听局域网或公网接口。
- 每个请求必须携带与受管进程环境变量一致的随机令牌。令牌是同用户本机进程间的意外访问防护，不是针对同用户恶意进程的强安全边界。
- 单条请求/响应最大 1 MiB，响应超限时返回稳定错误而非静默丢弃；UI 返回最大 500 项；运行时场景树最大 64 层/5000 节点，节点或 Resource 单次最多读取/写入 100 个已声明属性，批量游戏状态观察最多 32 个节点和 32 个附加属性；Editor 批处理最多 32 个严格类型操作、每个属性对象最多 100 项；3D 投影只接受 Node3D 或有限数值世界坐标，物理射线最长 100000 且只在所选 Camera3D 的当前 World3D 查询；单次输入保持最大 2 秒，组合输入最多 32 步且总保持/延迟不超过 5 秒；运行时等待最大 30 秒；暂停后单次推进最大 120 个 process/physics 帧；隔离物理采样最多复制 5000 个节点并推进 120 帧；编辑器场景树最大 64 层，编辑器 3D 截图索引限制为 0–3。
- 不提供任意代码执行、任意文件路径截图、shell、网络请求或动态对象调用。
- EditorPlugin 只允许创建可实例化的 `Node`/`Resource` 类型；节点名、移动环路、目标节点、属性描述符、只读标志、Resource 类兼容性、值类型、信号和目标方法均在 Godot 内验证。`owner`、`scene_file_path`、`resource_path` 等结构属性不能作为普通属性写入。
- 编辑器增删改、Resource 子属性更新、PackedScene Editable Children 和信号连接均记录到当前场景的 Godot 原生 Undo/Redo 历史；保存必须单独显式调用。Resource 更新只允许已声明、非只读属性，不允许动态方法调用。
- `godot_editor_batch` 先在逻辑场景索引中验证全部操作及前序 rename/move/delete 后的路径，再创建且只创建一个原生 Undo/Redo action；任一步失败都不会修改真实场景或历史。删除必须显式 `confirmDestructive: true`。批处理没有保存字段且永不落盘；随后保存失败只表示未持久化，不会自动回滚已经应用、仍可整体撤销的内存动作。
- 所有持久 Editor mutation 在 Bridge 权威点校验活动 `expectedScenePath`；save/undo/redo 还校验 native `expectedHistoryVersion`。这些 guard 是 MCP/CLI 0.2.0 的必填迁移，不提供静默无 guard 兼容期。
- 项目设置写入只允许已有的 `application/config/*`、`application/run/main_scene`、`display/window/*`、`rendering/*`、`physics/2d/*`、`physics/3d/*`，并限制为 bool/int/float、16 KiB 字符串或最多 256 项的字符串数组；`autoload/*`、`editor_plugins/*`、`filesystem/import/*` 与通用 `input/*` 必须走其他专用流程。InputMap 只接受有界的 key、mouse button、joypad button union，每次最多 32 个事件。
- `project.godot` 的持久设置和 InputMap 写入同时校验项目 fingerprint、调用方 SHA-256、Bridge 启动时缓存的 SHA-256，并在整个 Bridge 往返期间复用文本写入的同一 mutation lease。客户端先超时时通过有界 operation receipt 调和；无法证明操作终态或受管 Editor 已退出时保留 quarantine，阻止第二个参与写入者插入。该协调面向正常本地开发中的并发、超时与崩溃，不把同用户恶意进程作为威胁模型。
- Editor Bridge 默认对命令串行执行。仅 `hello` 与 `project_setting_operation_status` 可在写操作的 `await` 挂起期间并发执行，分别用于写前置握手和超时后的 operation receipt 调和，避免调和被写锁饿死。场景树、节点/资源读取和 `project_setting_get` 会等到当前写操作完成（含存盘或回滚），因此不会看到 `scene_open` 或继承场景创建过程中的临时场景，也不会读到尚未落盘、随后可能被回滚的项目设置。未知命令同样走串行路径。
- 外部 Resource 检查是只读接口，只加载项目内非链接 `.tres/.res`；未请求属性时仅返回类、路径与可编辑属性名，请求时最多编码 100 个属性。
- 继承场景创建复用 Godot `EditorInterface.open_scene_from_path(..., true)` 与原生场景保存，不手写 `.tscn` 内部字段。目标必须是项目内规范化 `.tscn` 路径且默认拒绝覆盖；创建出的文件不属于当前场景 Undo/Redo，调用方应使用 Git 恢复或删除。
- PackedScene、外部 Resource 以及 tagged Variant 中的 Resource 引用都必须是规范化的项目内 `res://` 路径，并逐段拒绝符号链接、目录联接点及其他重解析点。加载 Resource 时还会验证其类型与目标属性声明兼容。外部资源只写 `.tres` 且默认拒绝覆盖；Undo/Redo 可恢复节点引用，但不会删除已经创建的文件。
- Runtime 与 Editor 握手必须报告完全匹配的协议版本和该版本已知的能力名；版本、能力或握手结构不兼容时立即返回稳定协议错误，不继续发送业务命令。
- Runtime Bridge 通过临时 `--script` 主循环运行，不修改项目配置。EditorPlugin 必须显式安装和启用，但没有受管环境变量时不会监听。
- 隔离物理采样把当前场景复制到 `SubViewport` 的独立 World2D/World3D。采样期间保持 SceneTree 与全局物理帧运行，但禁用真实场景节点处理，并按 RID 去重停用真实场景根 Viewport 及所有子 Viewport 的 2D/3D 物理空间；结束后恢复物理空间、节点处理模式、SceneTree 暂停状态和模拟前 InputMap action。输入注入、隔离采样和暂停/推进控制串行执行，避免并发请求覆盖彼此的 Input 或 SceneTree 状态。客户端超时会随请求传入有界生命周期；排队或执行中的请求在截止、断连时取消并释放已注入输入。隔离仅保证这些真实物理空间和节点状态不会接收模拟动作；副本的 `_ready`、`_process`、`_physics_process` 及其访问的 autoload、文件、网络或其他全局单例仍会执行，因此该能力不是进程级或操作系统级沙箱，也不标注为只读/幂等工具。

## 仍需由调用方确认的边界

启动项目会执行项目已有的 autoload、场景脚本、原生扩展和工具脚本。对来源不可信的项目，应在操作系统级隔离环境中运行；本项目当前不提供容器或低权限账户沙箱。

截图回执只证明单个 `editor_viewport` 或真实 `runtime_frame` 及其项目/场景身份，始终不证明输入已产生预期交互；交互必须另用结构化 wait/assert 证明。核心也不提供云服务、账号、AI 资产生成、任意网络下载、任意脚本/对象探针、导出签名或托管发布。这些排除项不能通过 guidance、batch 或 debug report 绕过。
