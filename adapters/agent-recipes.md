# Codex 与 DeepSeek Harness 任务配方

两个客户端使用同一组高层 MCP 工具；DSH 只是在工具名前增加 `mcp__godot__`。

## 修改并验证 UI

1. 调用 `godot_doctor`，仅在出现 `fail` 时停止并按 `recovery` 修复。
2. 用 `godot_editor_launch` 打开项目，通过场景树和节点读取定位目标。
3. 用编辑器节点或 Resource 工具修改，保存后调用 `godot_project_check`。
4. 停止编辑器，调用 `godot_scene_launch` 启动游戏。
5. 用 UI 发现获得节点路径，截图保存变更前证据。
6. 注入输入，用 `godot_runtime_wait` 和 `godot_runtime_assert` 验证状态。
7. 再次截图，并始终调用 `godot_run_stop` 清理受管进程。

## 3D 自动化闭环

1. 读取或修改 Node3D 后保存，并捕获 `viewport=3d` 的编辑器截图。
2. 启动游戏，读取运行时树与目标节点状态。
3. 用 `godot_runtime_3d_project` 把目标投影到屏幕坐标。
4. 用 `godot_runtime_3d_raycast` 验证该像素命中预期碰撞体。
5. 注入 InputMap action，等待位置或业务状态变化并执行结构化断言。
6. 保存前后截图、断言结果和节点路径，最后停止运行。

不要仅凭截图宣称成功；截图是视觉证据，结构化断言才是完成条件。
