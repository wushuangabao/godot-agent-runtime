# 开发环境

本项目使用 `config/development.local.json` 显式记录本机 Godot 可执行文件和 DeepSeek Harness 源码目录。该文件包含机器专属绝对路径，已被 Git 忽略；可提交的格式示例位于 `config/development.local.example.json`。

```json
{
  "schemaVersion": 1,
  "godot": {
    "executable": "C:\\path\\to\\godot.windows.editor.x86_64.exe"
  },
  "deepseekHarness": {
    "root": "C:\\path\\to\\deepseek-harness"
  }
}
```

运行零依赖检查脚本验证配置：

```powershell
node scripts/check-development-environment.mjs
```

检查成功仅表示路径有效且 Godot headless 版本查询可以运行。源码编译、RC 或带 `custom_build` 标识的 Godot 可以用于日常开发，但发布前仍须使用项目支持矩阵中的原版稳定版本完成端到端复验。

DeepSeek Harness 是可选基准宿主。默认从官方仓库克隆到本机独立目录，不作为 Git 子模块或核心运行时依赖；首次从源码运行前，按照其上游文档安装依赖并构建。生成 MCP overlay 与保留项目工作目录的启动方式见 [DSH 适配说明](../adapters/deepseek-harness/README.md)。
