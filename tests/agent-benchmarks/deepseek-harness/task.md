# DeepSeek Harness Headless 优化闭环任务

只使用 `mcp__godot__godot_*` 工具完成以下任务，不修改项目文件。先读取 `godot_project_context`；需要详细流程时读取 `godot_agent_guide`。

1. 读取项目 context 与 fingerprint，诊断当前环境并检查 `examples/control-ui`。
2. 启动该项目的主场景，找到文本为 `Start` 的可见 Button。
3. 保存点击前 `runtime_frame`，点击该 Button；截图不得作为交互成功证明。
4. 等待 `/root/Main` 的 `meta:started` 变为 `true`，再断言 `/root/Main/StatusLabel` 的 `text` 等于 `Started`。
5. 先调用 diagnostics，再按游标增量读取日志；记录 context、batch（本只读任务应为 0）和 diagnostic 调用数。
6. 保存点击后 `runtime_frame`，记录结构化 wait/assert 与截图的不同 evidence class。
7. 停止全部受管运行，即使中途失败也必须尝试清理并报告最终状态。
8. 记录 MCP toolCount、稳定序列化的 toolSchemaBytes 和 instructionsBytes。
9. 最终只输出一个符合相邻 `report.schema.json` 的 JSON 对象，不要用 Markdown 代码块。

只有实际配置模型凭据并由目标 Headless Host 完成上述闭环时，`hostExecutionVerified` 才能为 `true`。没有模型凭据（credentials）时只验证 MCP 握手、Schema 和确定性预算，必须输出 `hostExecutionVerified:false`，不得生成或猜测模型工具选择率。
