# Terminal Sidebar

**English** · [简体中文](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_zh.md) · [日本語](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_ja.md)

[![CI](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml) [![Marketplace](https://img.shields.io/visual-studio-marketplace/v/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![Installs](https://img.shields.io/visual-studio-marketplace/i/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) [![MIT](https://img.shields.io/github/license/Photonico/terminal_sidebar)](LICENSE)

Independent terminals and document previews in VS Code. The **Primary Side Bar** uses collapsible sections; the **Secondary Side Bar** uses a compact tab strip. Keep Vim, Neovim, or another command-line tool beside its output and preview.

Requires VS Code **1.106+** on desktop or a remote extension host. No separate Node.js installation is needed to use the extension.

## Get started

1. Install a matching VSIX through **Extensions: Install from VSIX…**. [Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar) also lists published versions.
2. Open **Side Terminals** and select **+** for a shell. The arrow button opens the other side bar.
3. Select the gear to configure startup terminals. Closing a terminal keeps its startup profile.
4. Use **Preview in Sidebar Terminal** in the editor title bar for PDF, Markdown, LaTeX, HTML, CSS, JSON, or JSONC. LaTeX opens an existing compiled PDF; build with your usual tools first.

## Work beside your editor

- Saving a document refreshes its preview, including saves from Vim. PDFs support scrolling, single/two-page layouts, zoom, and remembered reading positions.
- Markdown supports common syntax, task lists, footnotes, and KaTeX math. **Change preview font** defaults to **Default**; your choice follows VS Code Settings Sync.
- Preview static HTML with local assets, or formatted CSS/JSON/JSONC source. HTML scripts and forms remain inactive.
- **Cmd+F / Ctrl+F** searches terminal buffers and document text, with case, whole-word, regex, counts, and highlighting. Right-click the search button to search all open tabs on both sides. PDF search requires a text layer.
- Double-click a PDF location to return to its LaTeX source through **SyncTeX**. Compile with `-synctex=1` and install `synctex`.
- Drag tabs to reorder; right-click for actions. Export terminal output as HTML, PDF, Markdown, or plain text.
- **Change tab marker** selects a themed icon. Startup-profile icons follow the same profile across repositories. Document icons follow the same file. Temporary-terminal icons stay workspace-local.

## Keep in mind

Reloading VS Code creates new shell processes. Directory memory and command status depend on shell integration and are best effort. Startup settings can sync: **do not store credentials in commands, arguments, or environment values**.

[User and development guide](https://github.com/Photonico/terminal_sidebar/blob/main/docs/guide.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/Photonico/terminal_sidebar/issues)

Design and maintenance: [Lu Niu (Photonico)](https://github.com/Photonico). Implementation, testing, and documentation assistance: **OpenAI Codex** and **Anthropic Claude**.

[MIT](LICENSE) © 2026 Lu Niu (Photonico). Bundled Codicons: Microsoft, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
