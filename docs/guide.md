# Terminal Sidebar guide

[English overview](https://github.com/Photonico/terminal_sidebar/blob/main/README.md) · [简体中文](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_zh.md) · [日本語](https://github.com/Photonico/terminal_sidebar/blob/main/docs/readme_ja.md)

## Terminals and tabs

The Primary Side Bar contains collapsible terminal sections. Several sections can stay open and share the available height. The Secondary Side Bar uses a tab strip. Each terminal has its own process; hiding a view or folding a section keeps that process alive. The ordinary VS Code terminal panel remains available.

Child-tab controls are **New**, **Search**, and **Close**. Right-click **+** for a terminal or document preview, or **×** to close every open tab in that side bar. In the Secondary Side Bar, double-click blank tab-strip space to create a terminal, or middle-click a tab to close it. Drag headings to reorder them. Keyboard alternatives are **Alt+Shift+Up/Down** in the Primary Side Bar and **Alt+Shift+Left/Right** in the Secondary Side Bar.

Right-click a terminal tab for rename, marker, restart, close, and export actions. Document tabs offer **Save a copy…** for the original file. The arrow in either title toolbar opens the other side, even when that view is hidden. **… → Usage** opens this guide's workflows in English, Chinese, or Japanese; **About** shows version, author, repository, and license information.

## Document previews

Use **Terminal Sidebar: Preview in Sidebar Terminal**, the preview icon in the editor title toolbar, or the document's context menu. Documents share tab ordering, markers, and the Primary Side Bar's folding layout with terminals. Opening a preview never adds a shell startup profile.

Markdown supports ordinary CommonMark/GFM syntax, including tables, task lists, strikethrough, fenced code, links, and local images, plus footnotes and KaTeX math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and fenced `math`). Raw HTML appears as text. Unsupported or oversized formulas remain readable as source; this is not a full LaTeX compiler or a renderer for every Markdown extension.

Use **Change preview font** for a dropdown beside its button. **Default** follows VS Code; **Editor font** follows the editor's font setting. **Custom font…** accepts a font name or fallback list directly in the dropdown. The User setting `terminalSidebar.markdownFontFamily` follows Settings Sync when enabled. Install any custom font on each device. **Open source file**, beside refresh, returns to the document in the main editor.

HTML (`.html` or `.htm`) renders as a static page with local images and stylesheets. Scripts, forms, embedded frames, and remote resources are inactive. CSS, JSON, and JSONC display formatted source; JSONC comments are retained. Invalid or expensive formatting falls back to the original text. Source files are never rewritten.

Text previews require UTF-8 files up to 4 MiB. Saving from Vim, Neovim, or another editor refreshes them, including replace-on-save. Resources must be in the document's directory or its subdirectories. Markdown filename aliases `.markdown`, `.mdown`, `.mkd`, `.mkdn`, and `.mdwn` are also supported.

PDF controls offer contents, page selection, zoom, and refresh. The gear selects continuous scrolling (default), single page, two pages, or dark reading. **Cmd/Ctrl + mouse wheel** zooms; **h/l** turns pages and **j/k** scrolls. Only nearby pages render. Page, zoom, and browsing preferences are remembered per workspace. Dark reading inverts page colours, including images; turn it off to inspect original colours.

Rebuilding a PDF refreshes it automatically; an incomplete or missing output keeps the last valid preview. Text previews share scroll and zoom controls, including **Cmd/Ctrl + mouse wheel** and **Cmd/Ctrl +/-/0**. Markdown and HTML also offer a vertical heading outline beside the document. Use **j/k** to scroll and **g/G** for the beginning/end; reading positions are remembered.

Opening `.tex` locates an existing compiled PDF. Root comments such as `% !TEX root = ../main.tex`, LaTeX Workshop output-directory settings, and common output folders help find it. If several PDFs match, choose one; if none exists, compile first or select the PDF manually. Terminal Sidebar does not run a LaTeX compiler or evaluate project build scripts. Continue using `latexmk`, LaTeX Workshop, or your existing workflow.

Double-click a PDF location for reverse **SyncTeX** navigation to the source in VS Code. Build with `-synctex=1`, retain the matching `.synctex` or `.synctex.gz` file, and make `synctex` available on the extension host. A configured `latex-workshop.synctex.path` can select its executable. Results depend on the compiler's mapping and may identify the nearest source line.

## Find, links, and status

Press **Cmd+F** on macOS or **Ctrl+F** on Windows/Linux in a terminal or preview. Find supports previous/next, case sensitivity, whole words, regular expressions, counts, and highlighting. Right-click the search button or a tab and choose **Find in all open tabs** to search both sidebars: terminal buffers, all PDF pages, rendered Markdown/HTML, and formatted source. Click a result to open its tab; Next/Previous moves between matches. Global results are a snapshot: reopen global Find after output or files change. **Esc** closes Find and returns focus. Image-only PDFs need a text layer from another tool. Large searches and expensive regular expressions have limits to keep the view responsive.

In a terminal, **Cmd-click / Ctrl-click** opens HTTP(S) links and source locations such as `src/app.ts:12:3`. Relative paths use the last known working directory; not every diagnostic format is recognized.

The tab dot reports the latest shell-reported command: running, failed, or completed. Viewing a completed tab clears its completion dot. Background bell notifications also clear when viewed. The footer retains the latest result. All colours follow the theme. Shells that cannot report command boundaries may provide less information; silence or a pause in output is never treated as completion.

## Tab markers and memory

**Change tab marker** offers bookmark, tag, flag, star, and ask, plus a searchable catalog under **Others**. Colours come from the theme's terminal palette and active/inactive tab foreground colours. Inactive icons blend the selected colour with the normal foreground. Tab-name text keeps its usual theme colour.

Startup-profile markers are saved by side and stable profile ID, so the same profile keeps its icon across repositories. Existing workspace choices are imported when no shared preference exists. Removing a shared icon also stays removed. Display names are not used to match profiles. Document icons follow the same file across workspaces and sides. Temporary terminal icons remain workspace-local.

Each workspace remembers tab order, names, selected tabs, expanded sections, and reading positions. Terminal working directories are restored when available. Typed input and output are not stored as layout memory, and the extension does not continuously log terminal output.

Reloading VS Code or closing its window ends the terminal processes. Restored terminals create new processes; commands typed into them are not replayed. Current startup profiles reopen, including profiles closed in the previous window. Supported shell integration reports directories and command boundaries on a best-effort basis. A missing remembered directory falls back to the workspace or home directory.

An idle prompt or exited process closes directly. Detected running commands, or an uncertain idle state, ask for confirmation. Restarting an active process also asks. These checks are advisory and do not intercept VS Code window shutdown.

## Startup configuration

Use the gear or **Terminal Sidebar: Configure Side Bars**. **Name**, **Command**, and **Shell** define each profile. A blank Command opens an interactive shell; a blank Shell uses the configured default. Put executable arguments in `args`, not inside the Shell path.

**Save** writes both startup lists. **Cancel** discards the draft. **Return to terminals** keeps it, including undo history, for later editing. Changing startup settings leaves existing processes alone; changes apply when that profile is next started. Each side permits 32 startup profiles and 32 additional ordinary terminals.

The User setting `terminalSidebar.sidebars` also supports literal argument arrays and environment overrides:

```json
"terminalSidebar.sidebars": {
  "left": [],
  "right": [
    { "id": "editor", "name": "Neovim", "command": "nvim", "shell": "" },
    {
      "id": "build", "name": "Build", "command": "", "shell": "bash",
      "args": ["--login"], "env": { "FOO": "bar", "UNUSED": null }
    }
  ]
}
```

`left` and `right` retain their public setting names and refer to the Primary and Secondary Side Bars, regardless of screen positions. Stable IDs preserve profile identity across renames and reorderings. Omitting `args` retains default arguments; `[]` clears them. An environment value of `null` removes that variable. The visual editor preserves these optional fields.

Startup profiles are User settings; repository settings cannot inject startup commands. **Commands, arguments, and environment values may sync through VS Code Settings Sync. Keep credentials in local credential storage or the tool's own login.** Installed tools and credentials must be set up separately on each machine.

## Export terminal output

Right-click a terminal tab and choose **Export…** for HTML, PDF, Markdown, or Plain text. Exports capture the retained buffer, not unlimited command history.

- HTML preserves colours without scripts or active links. Printing it from a browser can produce selectable PDF text; enable background graphics to retain colours.
- PDF preserves browser-rendered colours, fonts, and Unicode as page images. Text in this export is not selectable or searchable.
- Markdown embeds sanitized HTML. Readers that strip inline styles, including GitHub, may remove colours.
- Plain text removes formatting.

Text exports are limited to 1 Mi UTF-16 code units; HTML and Markdown to 8 Mi. PDF exports allow up to 16 MiB, 100 pages, and one million terminal cells. Oversized exports report an error.

## Compatibility and development

Use VS Code 1.106+ with a desktop or remote Node.js extension host. Browser-only and virtual workspaces are unsupported. SSH, WSL, and Dev Containers run tools on the remote extension host; install the matching extension package and tools there. Commands and document previews require a trusted workspace.

The extension follows public VS Code theme tokens and terminal font settings. Shell integration is loaded for supported interactive zsh, bash, fish, and PowerShell launches when enabled in VS Code. Custom launch arguments may disable automatic integration. Fonts still need the glyphs used by your programs.

Development uses Node.js 24 and npm:

```sh
npm ci
npm run check
npm run package -- --target darwin-arm64
```

`check` runs type checking, tests, and the build. **F5** opens an Extension Development Host. Package for the actual native host platform; do not relabel another platform's native binary. VSIX files go to `release/`. Packaging and Marketplace publication are separate actions. CI builds platform-specific packages; automated tests do not establish visual verification on every platform.

Keep modules focused, use descriptive `snake_case` for project-owned identifiers, and preserve required external API and published setting names. See [assets/README.md](https://github.com/Photonico/terminal_sidebar/blob/main/assets/README.md) for logo provenance and regeneration.

## Contributors and licence

- [Lu Niu (Photonico)](https://github.com/Photonico): project design and maintenance.
- **OpenAI Codex**: assistance with implementation, testing, and documentation.
- **Anthropic Claude**: assistance with implementation, testing, and documentation.

Commits with Codex contributions include `Co-authored-by: Codex <codex@openai.com>`. Commits with Claude contributions include a `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer.

[MIT](https://github.com/Photonico/terminal_sidebar/blob/main/LICENSE) © 2026 Lu Niu (Photonico). Bundled Codicons are Copyright Microsoft Corporation and licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); bundled notices identify their source.
