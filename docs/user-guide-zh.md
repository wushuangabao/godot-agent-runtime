# Godot Agent Runtime 快速上手

Godot Agent Runtime 可以让 Codex 操作并检查本机的 Godot 4.x 项目。你只需要描述想做什么，Codex 就可以读取项目、修改文件或场景、运行游戏、点击界面，并检查结果是否正确。

所有功能都在本机运行，不需要账号或云服务。

## 开始前准备

请先准备：

- Node.js 20 或更高版本
- Godot 4.x
- 一个创建好的 Godot 项目
- Codex

可以在终端运行以下命令检查 Node.js 版本：

```powershell
node --version
```

## 第一步：找到三个路径

安装命令需要三个绝对路径：

| 参数 | 应填写的内容 |
| --- | --- |
| `--workspace` | 你在 Codex 中打开的工作区或代码仓库目录 |
| `--godot-project` | 包含 `project.godot` 的目录，且必须位于工作区内 |
| `--godot` | Godot 可执行文件本身，不是它所在的文件夹 |

例如：

```text
工作区：      C:\GitHub\my-game
Godot 项目： C:\GitHub\my-game\GodotPrj
Godot 程序： C:\Tools\Godot\Godot_v4.6.2-stable_win64.exe
```

## 第二步：一键安装和配置

在 PowerShell 中运行下面的命令，并把三个示例路径换成你自己的路径：

```powershell
npx -y godot-agent-runtime@0.2.0 setup codex --workspace "C:\GitHub\my-game" --godot-project "C:\GitHub\my-game\GodotPrj" --godot "C:\Tools\Godot\Godot_v4.6.2-stable_win64.exe"
```

这条命令会自动：

- 记录本机 Godot 的位置
- 为当前工作区配置 Codex MCP Server
- 把配套的 EditorPlugin 安装到 Godot 项目的 `addons/godot_agent_runtime/`
- 启用该插件，同时保留项目中已有的其他插件

命令可以重复执行。已经是最新状态的内容会显示为 `unchanged`，不会重复添加配置。

## 第三步：重新打开 Codex 任务

Codex 当前已打开的任务不会自动加载刚添加的 MCP Server。安装完成后，请关闭并重新打开当前任务或项目。

重新打开后，可以直接发送：

> 先调用 godot_doctor 检查环境。检查通过后，读取这个 Godot 项目并运行主场景，确认没有报错，最后停止运行。

如果 `godot_doctor` 的结果为 `ok: true`，说明安装成功。

## 第一次实际使用

你不需要记住工具名称，直接用日常语言描述目标即可。例如：

> 把主菜单标题改成“开始冒险”，运行游戏并截图确认文字正确。

> 检查开始按钮是否可点击；点击后确认游戏进入下一页。

> 找出当前脚本错误并修复，然后重新检查项目。

一次完整任务通常会按下面的顺序进行：

```text
检查环境 → 读取项目 → 修改 → 静态检查
→ 启动游戏 → 观察或操作 → 断言结果 → 停止游戏
```

运行过程中，Codex 会优先读取场景树、节点属性和界面状态等结构化信息；只有需要确认画面时才截图。截图可以证明游戏画面确实运行了，但按钮是否生效等交互结果仍会通过状态或断言确认。

## 安装后项目里会多出什么

安装命令会创建或更新以下内容：

- 工作区的 `.godot-agent-runtime/config.local.json`：保存这台电脑上的 Godot 路径
- 工作区的 `.codex/config.toml`：注册 MCP Server；只维护带有 Godot Agent Runtime 标记的区段
- Godot 项目的 `addons/godot_agent_runtime/`：MIT 许可的 EditorPlugin
- Godot 项目的 `project.godot`：加入插件启用项

其中 `config.local.json` 包含本机路径，不适合直接复制给使用不同安装路径的人。

## 可选：直接使用命令行

完成 setup 后，在工作区目录中也可以直接运行以下命令：

```powershell
# 检查 Node.js、配置和 Godot
npx -y godot-agent-runtime@0.2.0 doctor

# 查看项目基本信息
npx -y godot-agent-runtime@0.2.0 inspect "C:\GitHub\my-game\GodotPrj"

# 静态检查项目
npx -y godot-agent-runtime@0.2.0 check "C:\GitHub\my-game\GodotPrj"

# 运行有限帧的无界面检查，然后自动退出
npx -y godot-agent-runtime@0.2.0 run "C:\GitHub\my-game\GodotPrj"
```

CLI 的正常结果会以 JSON 输出；失败结果会给出错误阶段和恢复建议。

`npx -y godot-agent-runtime@0.2.0 mcp` 是提供给 MCP 客户端的 stdio 服务，不是交互式终端程序。完成 setup 并重新打开 Codex 后，一般不需要手动运行它。

## 常见问题

### 找不到 Godot

确认 `--godot` 指向可执行文件本身，并且使用绝对路径。Windows 路径示例：

```text
C:\Tools\Godot\Godot_v4.6.2-stable_win64.exe
```

### 提示找不到 Godot 项目

确认 `--godot-project` 指向直接包含 `project.godot` 的目录，并且该目录位于 `--workspace` 内。

### Codex 中没有 `godot_doctor`

首次 setup 后必须重新打开 Codex 任务。仍未出现时，在同一个工作区重新执行 setup，然后再次打开任务。

### `godot_doctor` 报配置错误

重新运行原来的 setup 命令。它会安全更新自己的配置，并保留 `.codex/config.toml` 中的其他内容。

### 插件或协议版本不一致

重新运行 setup，关闭旧的 Godot 编辑器或游戏进程，再重新打开 Codex 任务。setup 会安装与 npm 包版本匹配的插件。

## 使用建议

- 开始任务时先让 Codex 调用 `godot_doctor` 和 `godot_project_context`。
- 修改后让 Codex 执行 `godot_project_check`，不要只凭代码内容判断成功。
- 需要交互验证时，让 Codex 启动场景、操作界面并执行结构化断言。
- 完成后让 Codex 调用 `godot_run_stop`，避免留下运行中的 Godot 进程。
- 只在你信任的本地项目中使用，并在修改前保持 Git 工作区可恢复。

更多技术细节：

- [工具契约](tool-contracts.md)
- [安全边界](security.md)
- [系统架构](architecture.md)
