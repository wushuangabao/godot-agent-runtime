# DeepSeek Harness 适配

本适配仅使用 DeepSeek Harness 的标准 MCP Client 和 Headless Profile，核心运行时不依赖 DSH。

先构建本仓库并生成项目级 Cordis overlay：

```powershell
pnpm run build
node packages/cli/dist/bin.js configure deepseek-harness --project C:\path\to\godot-project
```

随后从 Godot 项目工作区启动 DSH。仓库内启动器会保留该工作目录，并兼容已构建或源码安装的 DSH checkout：

```powershell
node adapters/deepseek-harness/run.mjs `
  --harness-root C:\path\to\deepseek-harness `
  --project C:\path\to\godot-project `
  -- "检查项目，启动主场景，截图并用结构化断言验证结果"
```

生成文件位于 `.dsh/godot-agent-runtime.patch.yml`。它把 MCP Server 注册为 `godot`，因此 DSH 中的工具名为 `mcp__godot__godot_*`。默认使用原生工具模式；要验证 Code Mode，可在启动前设置 `DSH_TOOLS_MODE=both`。

无需模型凭据的配置合成检查：

```powershell
node adapters/deepseek-harness/run.mjs `
  --harness-root C:\path\to\deepseek-harness `
  --project C:\path\to\godot-project `
  -- --dump-config
```

若 DSH checkout 尚未安装依赖或构建，启动器会返回明确错误；这不会影响 Codex 或核心 MCP Server。
