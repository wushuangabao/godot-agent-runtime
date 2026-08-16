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

## 已吸收的设计结论

阶段 1 到首个运行时闭环主要参考了本机审计的 Godot MCP Runtime 与 Summer Engine Agent：

- 采用 Godot MCP Runtime 已验证有效的 loopback 桥接、每次会话令牌、截图落盘后返回紧凑元数据，以及 UI 使用稳定节点路径和矩形描述的思路。
- 不采用其动态 `run_script` 能力，也不采用“注入 autoload、结束后恢复 `project.godot`”的生命周期；本项目使用固定命令表和 `--script` 临时主循环。
- Summer Engine Agent 清楚展示了编辑器实时树、运行时输入、视口截图与诊断轮询组合后的自验证价值；本项目保持原版 Godot，不依赖其定制引擎模块。
- 外部实现仅作行为与协议研究，没有复制其协议或把其代码作为运行时依赖。许可证边界继续记录在仓库 `LICENSING.md`。
