# DeepSeek Harness Headless 闭环任务

只使用 `mcp__godot__godot_*` 工具完成以下任务，不修改项目文件：

1. 诊断当前环境并检查 `examples/control-ui`。
2. 启动该项目的主场景，找到文本为 `Start` 的可见 Button。
3. 保存点击前截图，点击该 Button。
4. 等待 `/root/Main` 的 `meta:started` 变为 `true`。
5. 断言 `/root/Main/StatusLabel` 的 `text` 等于 `Started`，保存点击后截图。
6. 停止受管运行，即使中途失败也必须尝试清理。
7. 最终只输出一个 JSON 对象，字段符合相邻的 `report.schema.json`；不要用 Markdown 代码块。
