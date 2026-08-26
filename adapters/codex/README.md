# Codex 适配

Codex 桌面端、CLI 与 IDE 扩展共享 MCP 配置。本项目使用受信任项目中的项目级 `.codex/config.toml`。公开包是推荐接入方式：

```powershell
npx -y godot-agent-runtime@0.2.0 setup codex --workspace "C:\path\to\workspace" --godot-project "C:\path\to\workspace\GodotPrj" --godot "C:\path\to\Godot_v4.6.2-stable_win64.exe"
```

setup 只维护 `# >>> godot-agent-runtime managed section >>>` 与对应结束标记之间的区段，保留文件中的模型、项目和其他 MCP 配置；它同时写入工作区本机配置、复制 MIT addon，并以明确路径 `res://addons/godot_agent_runtime/plugin.cfg` 启用插件。重复运行应收敛为 `unchanged`。

源码检出模式继续兼容：

```powershell
pnpm run build
node packages/cli/dist/bin.js configure codex --project C:\path\to\godot-project
```

生成器只维护带标记的 `godot-agent-runtime` 区段，并保留文件中的其他配置。重新打开任务后，先调用 `godot_doctor`，再按 [共享任务配方](../agent-recipes.md) 执行闭环。

Codex 不会给当前已打开任务热加载新写入的 MCP Server。首次 setup 或受管区段变化后必须重开任务；若只是在源码检出中开发 runtime，可继续使用上面的 `pnpm run build` 和源码 CLI 路径。
