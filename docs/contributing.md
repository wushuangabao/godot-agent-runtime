# 贡献约定

开始工作前先阅读 [AGENTS.md](../AGENTS.md)、相关设计文档和当前 issue。许可证边界见 [LICENSING.md](../LICENSING.md)，本机路径配置与检查方式见 [development-environment.md](development-environment.md)。

## 工作规则

1. 优先提交小而可验证的改动；不要在没有基准或失败案例时大规模重写工具协议。
2. 新工具必须说明：使用场景、只读/写入属性、参数 Schema、成功响应、失败响应和验证方式。详见 [tool-contracts.md](tool-contracts.md)。
3. 返回错误时给出结构化错误码、发生阶段和可执行的恢复建议；不要只返回堆栈。
4. 新增编辑器能力前，先确认标准 Godot API 是否可以实现；不得无理由引入定制引擎依赖。
5. 新增运行时能力必须提供端到端测试，证明 Agent 实际观察或改变了运行游戏状态。
6. 不把模型 API、密钥或某家 Agent SDK 放进核心协议层。
7. 对外部参考项目的代码复用必须核对许可证并保留必要声明。
8. 默认保持向后兼容；需要破坏协议时更新协议版本与迁移说明。
9. 完成改动后至少运行受影响的单元测试、Godot headless 测试和一个相关基准任务。
10. 新增或修改 MCP 工具时，必须验证其可被 Code Mode 等程序化客户端组合调用，并验证 `structuredContent`、错误码、输出上限和工具清单。
