# Godot Agent Runtime npm 发布与 GalGame 接入设计

**状态：** 已批准

**日期：** 2026-08-26

**涉及仓库：** `E:\github\godot-agent-runtime`、`E:\github\GalGame`

## 目标

将 `godot-agent-runtime` 以单一、自包含的公共 npm 包 `godot-agent-runtime@0.2.0` 发布，并让 GalGame 通过固定版本的初始化脚本完成 Codex 项目级 MCP 配置、Godot EditorPlugin 安装和本机 Godot 路径配置。接入后，Codex 能以结构化工具读取、编辑、启动、观察和验证 `GodotPrj`，且 GalGame 不依赖 Git 子模块或某台机器上的 runtime 源码绝对路径。

## 当前基线

- `godot-agent-runtime` 位于 `main`，设计开始时与 `origin/main` 对齐，MCP/CLI 版本为 `0.2.0`，Editor transport 为 `0.7.0`，Runtime transport 为 `0.4.0`。
- runtime 当前是 pnpm workspace；根包及内部 `@godot-agent-runtime/*` 包均为私有开发包。
- GalGame 位于 `main`，设计开始时与 `origin/main` 对齐；Godot 项目根目录为 `GodotPrj`。
- 本机原版 Godot 可执行文件为 `D:\Godot\Godot_v4.6.2-stable_win64.exe`，自报版本为 `4.6.2.stable.official.71f334935`。
- npm Registry 在 2026-08-26 查询不到公开包 `godot-agent-runtime`；首个公共版本确定为 `0.2.0`。
- 本地和远端均无 `v0.2.0` 标签。用户已授权在完成验证后推送 runtime 发行提交、创建并推送 `v0.2.0`，再发布 npm 包。

## 已选方案

采用单一自包含 npm 包。公开入口只有 `godot-agent-runtime`，内部 workspace 包继续保持私有，不发布一组需要同步维护的公共子包。npm 包不充当源码下载器，不在安装或运行时克隆 Git 仓库，也不引入 GitHub Release 或 GalGame 子模块。

其他方案及拒绝原因：

- 公开所有 workspace 包会引入多个包名、作用域所有权和同步发版矩阵。
- npm 安装后再下载或构建源码会依赖网络、Git 与本机构建工具，违背本地优先和固定版本复现要求。

## 发行包架构

### 单一命令入口

包暴露 `godot-agent-runtime` 命令。现有 CLI 命令保持兼容，并新增：

```text
godot-agent-runtime mcp
godot-agent-runtime setup codex --workspace <PATH> --godot-project <PATH> --godot <EXE>
```

`mcp` 以 stdio 启动 MCP Server；标准输出只发送 MCP JSON-RPC，诊断继续写入标准错误。`setup codex` 是有界、幂等的安装组合命令，不执行任意工作流。

### 根包 manifest 契约

公共包从仓库根目录发布。根 `package.json` 删除 `private: true`，并固定下列公共字段；内部 workspace 包继续保留 `private: true` 和 `workspace:*`，只参与源码构建：

```json
{
  "name": "godot-agent-runtime",
  "version": "0.2.0",
  "type": "module",
  "license": "AGPL-3.0-or-later",
  "bin": {
    "godot-agent-runtime": "dist/npm/bin/godot-agent-runtime.js"
  },
  "files": [
    "dist/npm/bin/",
    "dist/npm/assets/",
    "README.md",
    "LICENSE",
    "LICENSING.md"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.4.3"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

根包同时补全 `description`、`repository`、`homepage`、`bugs` 和 `keywords`，但这些元数据不得改变上述入口、文件白名单、许可证或生产依赖边界。

### 构建与输出布局

新增私有的发行入口 `packages/release/src/bin.ts`，只负责把 `mcp` 分派给 MCP stdio server，把其他参数分派给 CLI。CLI 主函数和 MCP 启动函数改为可导入入口，现有源码模式的两个 bin 继续可用。

使用固定开发依赖 `esbuild` 生成一个 ESM 可执行文件，并保留 Node.js shebang：

```text
dist/npm/
├── bin/
│   └── godot-agent-runtime.js
└── assets/
    ├── addons/
    │   └── godot_agent_runtime/
    │       ├── LICENSE
    │       ├── plugin.cfg
    │       ├── plugin.gd
    │       ├── editor_bridge.gd
    │       └── runtime_entry.gd
    └── host/
        └── run-host.mjs
```

esbuild 必须打包全部私有 `@godot-agent-runtime/*` workspace 代码；产物中不允许残留这些包的裸导入。第三方 `@modelcontextprotocol/server`、`@modelcontextprotocol/server/stdio` 和 `zod/v4` 不打包，作为根包的生产依赖由 npm 正常安装。`esbuild`、TypeScript、Vitest 和 MCP 测试客户端只保留为开发依赖。

构建脚本以空目录重建 `dist/npm`，复制上述资产，并检查 esbuild metafile 和最终 JavaScript：内部 workspace 裸导入数必须为 0，外部运行导入集合必须精确等于根包声明的两个生产依赖家族。`prepack` 负责重建 npm 产物；`prepublishOnly` 运行完整发行验证，不能依赖仓库里遗留的旧 `dist/npm`。

### 包内容

npm tarball 必须通过 `files` 白名单只包含：

- `dist/npm/bin/godot-agent-runtime.js` 单一 CLI/MCP JavaScript 入口；
- 受管进程 host 脚本；
- `assets/addons/godot_agent_runtime/` 下采用 MIT 的 EditorPlugin 与 Runtime Bridge 资产；
- README、LICENSE、package metadata 和运行所需的许可证材料。

发行 JavaScript 不得再从 npm 解析私有的 `@godot-agent-runtime/core`、`@godot-agent-runtime/protocol`、`@godot-agent-runtime/cli` 或 `@godot-agent-runtime/mcp-server`。开发仓库仍保留现有 workspace 边界和测试入口。

### 运行资产定位

源码检出模式和 npm 打包模式共享一个资产定位边界：

- 源码检出继续解析仓库内 `addons/godot_agent_runtime/` 和 Core host 脚本；
- npm 模式只解析 tarball 内的受控资产目录；
- 找不到资产时返回稳定错误码、失败阶段、目标路径和恢复建议，不回退到联网下载或不受控的全盘搜索。

插件、MCP Server、CLI 和包版本属于同一个 npm 版本单元；更新其中任一发行内容都必须发布新 npm 版本。根包的 `license` 继续表示 JS 核心的 AGPL-3.0-or-later；addon 子目录以自己的 MIT `LICENSE` 和 SPDX 标识形成更具体的文件级许可边界。

### Codex 配置

npm 模式生成的受管区段固定到实际运行的包版本：

```toml
# >>> godot-agent-runtime managed section >>>
[mcp_servers.godot-agent-runtime]
command = "npx"
args = ["-y", "godot-agent-runtime@0.2.0", "mcp"]
cwd = "<WORKSPACE_ABSOLUTE_PATH>"
# <<< godot-agent-runtime managed section <<<
```

生成器只维护带标记区段，保留 `.codex/config.toml` 中其他设置。源码检出模式继续支持当前的绝对 Node/MCP Server 入口，避免破坏 runtime 开发和既有测试。Codex 官方支持项目级 `.codex/config.toml` 及 stdio MCP 的 `command`、`args`、`env` 和 `cwd`；修改配置后需重新打开任务或重启相应客户端才能加载新 MCP Server。

## 本机 Godot 配置

发布后的工具不能默认依赖 runtime 源码仓库中的 `config/development.local.json`。配置解析顺序确定为：

1. 工具调用或 CLI 显式传入的 `configPath`；
2. `GODOT_AGENT_RUNTIME_CONFIG` 环境变量；
3. 当前工作目录下存在的 `.godot-agent-runtime/config.local.json`；
4. 为源码开发向后兼容的 `config/development.local.json`。

`setup codex` 在 workspace 根目录原子写入 `.godot-agent-runtime/config.local.json`，内容沿用 schema version 1，并记录用户显式提供的 Godot 编辑器绝对路径。它不会猜测、下载或安装 Godot。

## GalGame 接入

### 提交到 GalGame 的内容

- `GodotPrj/addons/godot_agent_runtime/`：由 `godot-agent-runtime@0.2.0` 安装的 MIT 插件快照及该目录的 MIT `LICENSE`。
- `GodotPrj/project.godot`：在保留全部现有 EditorPlugin 的前提下，以明确路径 `res://addons/godot_agent_runtime/plugin.cfg` 启用插件。
- `scripts/setup-godot-agent-runtime.ps1`：固定调用 `godot-agent-runtime@0.2.0`。
- `.godot-agent-runtime/config.example.json`：不含机器绝对路径的配置格式示例。
- `.gitignore`：忽略 `.codex/` 和 `.godot-agent-runtime/config.local.json`。
- `AGENTS.md`：增加 runtime 协作入口、`GodotPrj` 项目根、验证阶梯和证据边界。

机器相关的 `.codex/config.toml` 与 `config.local.json` 不提交。插件快照、版本固定脚本和协作说明提交，从而使每台机器能从同一 npm 版本幂等重建本地配置。

### 初始化入口

GalGame 用户运行：

```powershell
.\scripts\setup-godot-agent-runtime.ps1 -GodotPath "D:\Godot\Godot_v4.6.2-stable_win64.exe"
```

PowerShell 脚本计算自身所在仓库根目录，不依赖调用者当前目录，然后执行固定版本：

```text
npx -y godot-agent-runtime@0.2.0 setup codex
  --workspace <GalGame root>
  --godot-project <GalGame root>\GodotPrj
  --godot <GodotPath>
```

组合命令按以下顺序工作：

1. 只读验证 Node.js 20+、workspace、`GodotPrj/project.godot` 和 Godot 可执行文件。
2. 使用 `--headless --version` 验证 Godot 4.x，并记录精确版本字符串。
3. 计算计划写入的全部内容；任何输入错误在写入前失败。
4. 原子写入本机配置和 Codex 受管区段。
5. 复制或更新完整插件文件集。
6. 仅在插件文件完整后更新 `project.godot` 的启用列表，保留其他插件；目标配置只保留明确路径 `res://addons/godot_agent_runtime/plugin.cfg`，发现旧裸名称 `godot_agent_runtime` 时将其迁移为该路径，并去除重复项。
7. 返回每个目标的 `created`、`updated` 或 `unchanged`、检测到的 Godot 版本及重启 Codex 提示。

单文件更新使用 create/SHA-256 guard 和原子替换。跨文件操作不伪装成事务：若进程在多个原子写入之间中断，结果必须列出已完成目标；再次运行同一命令会检测并修复到目标版本。项目检查与 Editor 启动前置条件以明确路径为规范值，但在 `0.2.x` 中继续把旧裸名称识别为已启用，以免现有项目在运行安装器迁移前被拒绝。

## Codex 在 GalGame 中的工作流

重新打开任务并加载 MCP Server 后，`AGENTS.md` 要求 Codex：

1. 先调用 `godot_doctor`，确认 Node、配置、Godot 和 loopback。
2. 以 `GodotPrj` 调用 `godot_project_context`，取得 project fingerprint、活动运行和诊断摘要。
3. 文件修改使用 project fingerprint 与 create/SHA-256 guard；场景持久修改使用活动场景和 history version guard。
4. 场景修改优先使用 EditorPlugin 与原生 Undo/Redo；多个节点操作使用严格 typed batch。
5. 按“静态检查 → 受管启动 → 结构化观察/断言 → 必要时截图 → 停止和清理”的顺序验证。
6. 截图只证明视觉状态；交互成功必须由结构化状态、属性或断言证明。

## 安全与许可证边界

- MCP 与 Godot Bridge 继续只监听 loopback，并使用每次运行的随机令牌。
- npm 包不包含模型 API、密钥、账号、遥测、云服务、postinstall 下载或任意脚本探针。
- setup 不读取、打印或保存 npm 认证令牌；npm 登录和二次认证交给 npm CLI。
- TypeScript/JavaScript 核心、MCP Server、CLI 与未另行标注的仓库文件继续采用 AGPL-3.0-or-later。
- `addons/godot_agent_runtime/` 整个子目录改用 MIT：目录内增加完整 MIT `LICENSE`，四个现有插件文件增加相应 SPDX 标识，`LICENSING.md` 和 README 明确该例外。
- addon 的 Git 历史作者记录均指向同一邮箱；实际改为 MIT 前仍须由版权所有者确认授权。本次用户批准该设计不替代无法验证的第三方版权许可。
- GalGame 只复制具有明确 MIT 边界的 addon 子目录，不复制 AGPL 的 JS 核心。npm 安装缓存中的 AGPL 核心继续作为独立 MCP/CLI 程序运行。
- GalGame 的玩法、剧情、资源和业务代码不在接入改动范围内。

## 失败处理

所有新失败沿用稳定结构：`code`、`stage`、`message`、`details`、`recovery`。

- 包资产缺失：失败并指出缺失资产，不联网修复。
- Godot 路径无效或版本非 4.x：在任何项目写入前失败。
- Codex 受管标记不完整：拒绝覆盖，保留原文件并提供修复建议。
- 插件安装中断：保留已完成原子文件，暂不启用不完整插件；幂等重试收敛。
- 插件启用项：安装器只写 `res://addons/godot_agent_runtime/plugin.cfg`；旧裸名称会迁移，重复的裸名称/完整路径会收敛成一个完整路径。
- `project.godot` 在读取后发生变化：SHA guard 拒绝覆盖，要求重新读取后重试。
- npm 发布前认证失败：停止在发布门，不创建错误的成功记录。
- `0.2.0` 一旦成功发布即不可覆盖或复用；发布后发现缺陷使用 `0.2.1` 修复，不 unpublish 首发版本。

## 发布流程

### 发布前验证

在 `godot-agent-runtime` 中完成：

1. `pnpm run check` 全量通过。
2. `git diff --check` 通过，worktree 与预期发行内容一致。
3. 根 package manifest 的 `bin`、`files`、`dependencies` 和 `publishConfig` 与本设计精确一致；内部 workspace 包仍为私有。
4. `npm pack --dry-run` 的文件列表符合白名单，产物中没有 workspace 源码、测试、开发配置或私有包 manifest。
5. 检查发行 bundle 没有任何 `@godot-agent-runtime/*` 运行时导入，只有已声明的 `@modelcontextprotocol/server` 和 `zod` 外部生产依赖。
6. 生成真实 tarball，并在 monorepo 外的临时目录安装，使 npm 实际安装声明的两个生产依赖。
7. 从 tarball 验证 CLI 版本/帮助、MCP initialize、工具 Schema、兼容性 payload、资产定位、Codex 配置保留和两次插件安装幂等。
8. 使用原版 Godot 4.6.2 对同时含有多个显式插件路径的临时项目完成 addon 路径迁移、Editor/Runtime Bridge 实际握手与清理。

### 外部发布

在所有发布前门禁通过后：

1. 再次查询 npm 包名与版本，确认 `0.2.0` 未被占用。
2. 运行 `npm whoami`；不在日志或提交中保存凭据。
3. 提交发行改动并推送到 `origin/main`。
4. 在已验证提交上创建并推送 `v0.2.0`。
5. 从干净 worktree 对同一提交执行 `npm publish --access public`。
6. 从 npm Registry 重新安装 `godot-agent-runtime@0.2.0`，验证版本、CLI、MCP 握手和 tarball 内容。

标签必须指向实际发布 tarball 所对应的提交。若 push、tag 或 publish 任一步失败，报告准确外部状态，不把未发生的后续步骤描述为完成。

## GalGame 验收

npm 发布后，只使用公开包完成 GalGame 接入，不回退到 sibling runtime 源码：

1. 运行固定版本 PowerShell 初始化脚本两次，第二次所有目标为 `unchanged`。
2. 检查 GalGame diff 只包含已批准的 MIT 插件、显式插件路径配置、脚本、示例、忽略规则和 Agent 指南；`project.godot` 中不存在裸名称 `godot_agent_runtime`。
3. 使用 `D:\Godot\Godot_v4.6.2-stable_win64.exe` 运行 `godot_doctor`。
4. 读取 `GodotPrj` 项目上下文并完成项目静态检查。
5. 启动受管 Godot Editor，完成握手、场景树读取和停止。
6. 启动游戏，完成运行状态读取、结构化断言、截图和停止清理。
7. 检查 `.godot/agent-runtime/` 下没有遗留受管进程状态；证据文件按工具契约保留或清理。

上述验证不得修改 GalGame 游戏内容。Editor/Runtime 自动化成功不自动证明真机、导出包、发行性能或生产发布。当前 Codex 任务不能热加载新 MCP 配置；本轮可用独立 MCP Client 证明握手，Codex UI 工具出现需在重新打开任务后确认。

## 提交与推送边界

- runtime：设计文档先单独本地提交；发行实现完成并验证后，按用户授权推送 `origin/main`、推送 `v0.2.0` 并发布 npm。
- GalGame：接入改动可以本地提交，但不推送，除非用户另行明确授权。
- 不改写两个仓库的既有历史，不混入无关工作区改动。

## 非目标

- 不发布 GitHub Release。
- 不把 runtime 加为 GalGame 的 Git 子模块、subtree 或源码副本。
- 不发布内部 `@godot-agent-runtime/*` workspace 包。
- 不增加全局 Codex MCP 配置；只生成 GalGame 项目级本地配置。
- 不自动下载 Godot、Node.js 或 npm 凭据。
- 不修改 GalGame 的玩法、UI、剧情、资源、存档或导出设置。
- 不把截图当作交互或功能成功的唯一证据。
