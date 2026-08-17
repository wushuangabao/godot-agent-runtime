# Codex 与 DeepSeek Harness 任务配方

两个客户端使用同一组高层 MCP 工具；DSH 只是在工具名前增加 `mcp__godot__`。本页是入口说明，不是另一份配方真源：完整 playbook 与 `edit-and-verify-ui`、`edit-and-verify-3d`、`fix-script-error`、`safe-scene-batch`、`collect-debug-report` 五个配方均由 Core 的 `getAgentGuide()` 生成，通过 `godot_agent_guide` 或 `agent-guide [recipe-id]` 读取。

固定验证阶梯是：context → compile → edit → visual → runtime → interactive → cleanup。任何修改前先读取 `godot_project_context`；单脚本先 `godot_script_check`，项目级再 `godot_project_check`；诊断先 `godot_diagnostics`，再按 `nextActions`/cursor 读取日志；所有受管运行最终都用 `godot_run_stop` 收口。

## 修改并验证 UI

1. 调用 `godot_project_context` 取得项目 fingerprint 和主场景，不猜路径。
2. 用 `godot_editor_launch` 打开项目，从 `godot_editor_status` 读取活动 scene/history guard。
3. 多节点修改优先 `godot_editor_batch`，保存必须随后独立调用并使用最新 history receipt。
4. 先检查改变的脚本，再检查项目。
5. 停止编辑器，调用 `godot_scene_launch` 启动游戏。
6. 用 UI 发现获得节点路径；截图只保存视觉证据。
7. 注入输入，用 `godot_runtime_wait` 和 `godot_runtime_assert` 验证状态。
8. 始终调用 `godot_run_stop` 清理受管进程。

## 3D 自动化闭环

1. 读取或修改 Node3D 后保存，并捕获 `viewport=3d` 的编辑器截图。
2. 启动游戏，读取运行时树与目标节点状态。
3. 用 `godot_runtime_3d_project` 把目标投影到屏幕坐标。
4. 用 `godot_runtime_3d_raycast` 验证该像素命中预期碰撞体。
5. 注入 InputMap action，等待位置或业务状态变化并执行结构化断言。
6. 保存前后截图、断言结果和节点路径，最后停止运行。

不要仅凭截图宣称成功；截图是视觉证据，结构化断言才是完成条件。
