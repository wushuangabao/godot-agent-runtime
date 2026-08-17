# Licensing

Godot Agent Runtime 当前仓库默认采用 **GNU Affero General Public License v3.0 or later**（SPDX：`AGPL-3.0-or-later`）。完整许可证正文见 [LICENSE](LICENSE)。

该默认许可覆盖项目的核心代码，包括 MCP Server、CLI、Godot EditorPlugin、Runtime Bridge 以及未另行标注许可的其他文件。

## 边界

- Codex、Claude Code 或其他程序仅通过 MCP/CLI 协议与本项目通信，不会仅因这种通信而自动适用本项目许可证。
- 使用本工具创建、修改或验证的用户 Godot 项目及游戏，不会仅因使用本工具而自动适用 AGPL。
- 未来若提供需要复制进用户游戏的模板或生成脚手架，应在对应目录和文件中明确标注 `MIT` 或 `CC0-1.0`，避免将用户游戏置于 AGPL 下。
- 未来若将文档单独改为 `CC-BY-SA-4.0`，必须在文档目录中增加明确的 SPDX 标识和对应许可证正文；在此之前，文档沿用仓库默认许可证。
- 第三方代码和资源继续服从各自的许可证，并应保留原有版权和许可声明。

## 0.2.0 Summer 公开行为研究

0.2.0 的项目上下文、guard、typed batch、诊断漏斗、证据语义与 Agent guidance 参考了 Summer Engine Agent 在公开 commit `933fc30d77ce6b1eaaf356197377795cb8df0c59` 展示的行为和接口思想。该上游仓库标注 MIT；本项目只阅读公开 TypeScript MCP 注册、文档、skills 和 LICENSE，随后基于原版 Godot API 与本项目既有架构独立实现。

本轮没有复制 Summer 定制引擎代码或源码片段，也没有新增 Summer 运行时/构建依赖，因此没有需要随本轮加入的 Summer 源码版权 notice。未来如实际复制 MIT 源码，贡献者必须在同一提交保留原版权和许可证文本；不能只在比较文档中笼统致谢。

除非文件或子目录包含更具体的许可证声明，否则一律以根目录 `LICENSE` 为准。
