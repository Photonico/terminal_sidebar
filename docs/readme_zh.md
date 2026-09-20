# Terminal Sidebar

[English](https://github.com/Photonico/terminal_sidebar/blob/main/README.md) · **简体中文** · [日本語](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_ja.md)

[![CI](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml) [![Marketplace](https://img.shields.io/visual-studio-marketplace/v/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![Installs](https://img.shields.io/visual-studio-marketplace/i/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![MIT](https://img.shields.io/github/license/Photonico/terminal_sidebar)](https://github.com/Photonico/terminal_sidebar/blob/main/LICENSE)

在 VS Code 侧栏中使用独立终端和文档预览。**Primary Side Bar（主侧栏）**采用可折叠分区，**Secondary Side Bar（辅助侧栏）**采用紧凑的标签栏。让 Vim、Neovim 等命令行工具与运行结果、文档预览并排显示。

**0.10.0 为预发布构建。** 需要 VS Code **1.106+**，以及桌面或远程 Node.js 扩展宿主。

## 快速开始

1. 通过 **Extensions: Install from VSIX…** 安装与扩展宿主平台匹配的 VSIX。[扩展商店](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar)也提供已发布的版本。
2. 打开 **Side Terminals**，点击 **+** 创建终端。箭头按钮可以打开另一侧的终端视图。
3. 点击齿轮配置启动终端。关闭终端不会删除对应的启动配置。
4. 点击 **Open Preview…**，选择 `.pdf`、`.md`、`.markdown` 或 `.tex` 文件。LaTeX 预览会打开已有的编译结果，请先用惯用工具生成 PDF。

## 配合你的编辑器

- 用 Vim 或其他编辑器保存 Markdown 后，预览会自动刷新；PDF 重新生成后也会刷新。阅读位置会被记住。
- 按 **Cmd+F / Ctrl+F** 搜索终端缓冲区、整份 PDF 或 Markdown，支持区分大小写、全字匹配、正则表达式、结果计数和高亮。PDF 搜索需要文本层。
- 双击 PDF 中的位置，通过 **SyncTeX** 跳回 LaTeX 源文件。需要以 `-synctex=1` 编译，并安装 `synctex` 可执行程序。
- 拖动标签可调整顺序，右键查看可用操作。终端输出可以导出为 HTML、PDF、Markdown 或纯文本。
- 用 **Change tab marker** 选择跟随主题的标签图标。同一启动配置的图标可跨仓库保留；临时终端和文档标签的图标只保存在当前工作区。

## 使用须知

重新加载 VS Code 会创建新的 shell 进程。工作目录记忆和命令状态检测依赖 shell 集成，只能尽力恢复和判断。启动配置可能随设置同步：**请勿在命令、参数或环境变量中保存凭据**。

[使用与开发指南（英文）](https://github.com/Photonico/terminal_sidebar/blob/main/docs/guide.md) · [更新记录](https://github.com/Photonico/terminal_sidebar/blob/main/CHANGELOG.md) · [问题反馈](https://github.com/Photonico/terminal_sidebar/issues)

设计与维护：[Lu Niu (Photonico)](https://github.com/Photonico)。实现、测试与文档协助：**OpenAI Codex**。

[MIT](https://github.com/Photonico/terminal_sidebar/blob/main/LICENSE) © 2026 Lu Niu (Photonico)。内置 Codicons 由 Microsoft 提供，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。
