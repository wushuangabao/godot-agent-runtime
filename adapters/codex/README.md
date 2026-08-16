# Codex 适配

Codex 桌面端、CLI 与 IDE 扩展共享 MCP 配置。本项目使用受信任项目中的项目级 `.codex/config.toml`：

```powershell
pnpm run build
node packages/cli/dist/bin.js configure codex --project C:\path\to\godot-project
```

生成器只维护带标记的 `godot-agent-runtime` 区段，并保留文件中的其他配置。重新打开任务后，先调用 `godot_doctor`，再按 [共享任务配方](../agent-recipes.md) 执行闭环。
