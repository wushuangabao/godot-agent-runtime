# 外部参考

阶段 0 应先审计这些参考实现，建立能力矩阵、许可证清单和可复用/不可复用代码边界，避免再造一个能力重叠但不完整的 Godot MCP。

- [Godot MCP Runtime](https://github.com/Erodenn/godot-mcp-runtime)：临时 Runtime Bridge、零项目残留。
- [Godot AI](https://github.com/hi-godot/godot-ai)：广泛的编辑器操作和客户端配置。
- [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)：确定性运行时测试与结构化观察。
- [Godogen](https://github.com/htdt/godogen)：Agent 工作流、技能和视觉自修复循环。
- [Summer Engine Agent](https://github.com/SummerEngine/summer-engine-agent)：Agent 工具层、技能路由和 Godot 控制接口设计。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：MCP 客户端、Headless Agent、Code Mode、事件日志和跨 Agent 基准宿主。
- [DeepSeek Harness 橙皮书](https://github.com/alchaincyf/deepseek-harness-orange-book)
- [Godot 自定义 C++ 模块](https://docs.godotengine.org/zh-cn/4.x/engine_details/engine_api/custom_modules_in_cpp.html)

## Summer Engine Agent 冻结审计与决策投影

本轮只审计 Summer Engine Agent 公开仓库在 commit `933fc30d77ce6b1eaaf356197377795cb8df0c59` 的 TypeScript MCP 注册、README 行为说明、skills 和 MIT LICENSE；没有检查或依赖其闭源/定制引擎实现。冻结清单位于 `docs/research/summer-mcp-inventory.json`，包含 62 个公开工具与 5 个跨工具行为；每个 id 在 `docs/research/summer-mcp-decisions.json` 中有且只有一条结论。上游未来增删必须重新冻结来源和差异，不能静默并入当前投影。

<!-- summer-capability-projection {"itemCount":67,"decisionCounts":{"adopt":1,"adapt":28,"existing":7,"reject":26,"defer":5}} -->

| 结论 | 数量 | 0.2.0 处理原则 |
|---|---:|---|
| adopt | 1 | 采用显式项目上下文，但用本项目自己的 identity/snapshot/guard 实现。 |
| adapt | 28 | 吸收公开行为思想，映射到原版 Godot、固定命令表、typed batch、结构化诊断与证据。 |
| existing | 7 | 已有受管运行、结构化场景树/状态等能力，不增加同义工具。 |
| reject | 26 | 拒绝云、账号、托管资产/生成、任意 URL、任意探针等超出本地核心边界的能力。 |
| defer | 5 | 发布/部署类工作流延期到独立外部或高风险设计评审。 |

这是对公开行为和接口思想的独立实现，没有复制 Summer engine 代码或把 Summer 包作为运行时依赖。若未来实际引入任何 MIT 源码片段，必须在同一变更中保留其版权和许可证声明；本轮没有这种复制。

相比参考层，本项目继续保留自己的重点：Runtime Bridge 的结构化节点观察/断言、wait 后的 expected/actual 证明、暂停和确定性有限推进、隔离 World2D/World3D 物理采样，以及区分 `editor_viewport`/`runtime_frame` 的诚实证据回执。`godot_editor_batch` 只接受版本化 fixed-command union，不允许 raw engine operation。

## 已吸收的设计结论

阶段 1 到首个运行时闭环主要参考了本机审计的 Godot MCP Runtime 与 Summer Engine Agent：

- 采用 Godot MCP Runtime 已验证有效的 loopback 桥接、每次会话令牌、截图落盘后返回紧凑元数据，以及 UI 使用稳定节点路径和矩形描述的思路。
- 不采用其动态 `run_script` 能力，也不采用“注入 autoload、结束后恢复 `project.godot`”的生命周期；本项目使用固定命令表和 `--script` 临时主循环。
- Summer Engine Agent 清楚展示了编辑器实时树、运行时输入、视口截图与诊断轮询组合后的自验证价值；本项目保持原版 Godot，不依赖其定制引擎模块。
- 外部实现仅作行为与协议研究；许可证边界继续记录在仓库 `LICENSING.md`。
