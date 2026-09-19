# Terminal Sidebar

[![CI](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/Photonico/terminal_sidebar/actions/workflows/ci.yml)
[![Marketplace version](https://img.shields.io/visual-studio-marketplace/v/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ConAntares.terminal-sidebar)](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar)
[![MIT licence](https://img.shields.io/github/license/Photonico/terminal_sidebar)](LICENSE)

Terminal Sidebar brings independent terminals into the VS Code side bars. The **Primary Side Bar** organises terminals as collapsible sections; the **Secondary Side Bar** uses a compact tab strip. Each terminal runs its own shell, leaving the ordinary terminal panel available for other work. These side bars are on the left and right by default, respectively, but VS Code allows their positions to change.

**Version 0.7.1 is a pre-release for testing.** It requires VS Code **1.106 or later** and a desktop or remote Node.js extension host. Browser-only and virtual workspaces are unsupported.

## Getting started

1. Install **Terminal Sidebar** by **Luke Niu** (`ConAntares.terminal-sidebar`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar), choosing the pre-release version. A matching VSIX can also be installed through **Extensions: Install from VSIX…**.
2. Open **Side Terminal** from the Activity Bar or the Secondary Side Bar.
3. Use **+** to open an ordinary shell. In the Secondary Side Bar, double-clicking blank space in the tab strip also creates a terminal.
4. Use either gear to open the configuration editor in the Primary Side Bar. Add any terminals that should open automatically when their side bar starts.

Both title toolbars include **+**, followed by **Open Secondary Terminal** in the Primary Side Bar or **Open Primary Terminal** in the Secondary Side Bar, then **Save**. The navigation buttons use circled right and left arrows, respectively. When either side bar has no tabs, **Open secondary side bar terminals** or **Open primary side bar terminals** appears between **New terminal** and **Configure startup terminals**. These controls open and focus the other Side Terminal view, including when it is hidden; they do not toggle it closed.

For example, add **Neovim** as a startup name and `nvim` as its command. You can use `vim`, `nano`, or any other installed command-line tool in the same way. Each tool keeps its own configuration and works as it would in an ordinary terminal.

After updating the extension, reload the VS Code window to load the new code.

## Open terminals and startup settings

An **open terminal** belongs to the current workspace window. A **startup profile** describes a terminal to open when its side bar starts. These are separate objects: closing a tab ends its process without deleting its startup profile.

The Secondary Side Bar's tab strip has a **+** button to create a terminal and a **×** button to close the selected one. A middle click closes the tab beneath the pointer. Double-click blank tab-strip space to create a terminal. New ordinary shells are named **Term 0**, **Term 1**, and so on, with an independent counter on each side. Closing all ordinary tabs resets that side's counter to **Term 0**, even when startup tabs remain. Existing names are skipped.

The pencil button immediately before **×** opens an inline **Rename terminal** field. In the Primary Side Bar it renames that section's terminal; in the Secondary Side Bar it renames the selected terminal. Press **Enter** to confirm or **Esc** to cancel. Names are remembered for this workspace, without changing startup profiles, selection, expanded sections, or running processes.

The Primary Side Bar presents an Explorer-style list of collapsible terminal sections. Several sections can be expanded at once and share the available height. Expanding or collapsing keeps their order; when all sections are collapsed, they form a compact list at the top with consistent header styling. Collapsing a section hides its terminal and preserves the process; its close control ends the process. The status row follows the terminal background when an expanded terminal sits directly above it, and the side bar background otherwise. Empty side bars show guidance and buttons at the top. This layout uses a single Webview View and is not a collection of native Explorer panes.

Drag a tab or section heading to change its position on the same side. A marker shows whether it will move before or after the target. With a heading focused, **Alt+Shift+Left/Right** in the Secondary Side Bar or **Alt+Shift+Up/Down** in the Primary Side Bar moves it one position. Reordering preserves the running process, current selection, and expanded sections; it does not edit startup settings.

The two sides have separate startup lists, open tabs, selections, terminal dimensions, and processes. Even terminals with the same name run independently. A command-line tool may still share its own global login or files between processes.

Each side supports up to **32 startup profiles** and **32 additional ordinary terminals**. Terminals begin when their side bar is first used in a trusted workspace, including background startup tabs. Opening configuration alone does not run commands. Switching tabs, folding sections, or hiding a side bar does not restart processes or repeat startup commands.

The Primary Side Bar uses 26 px headers, with extra vertical spacing around each title; the Secondary Side Bar uses 24 px headers. Both use the VS Code interface font. Colours and corner radii come from the current theme. Terminal scrollbars use the editor's scrollbar sizes and visibility together with its normal, hover, and active slider colours. Theme and setting changes update open terminals without restarting their processes. Terminal text continues to follow the integrated-terminal font settings.

The view uses documented [Webview theme variables](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content) and public terminal APIs. It follows the host's appearance where those APIs expose it; it cannot inherit arbitrary private editor styling or guarantee pixel-identical behaviour across future VS Code releases.

## Search, links, and output

- Press **Cmd+F** on macOS or **Ctrl+F** on Windows/Linux while a terminal has focus to search its retained buffer. The themed overlay follows VS Code's compact find-widget layout, including previous/next matches, case sensitivity, whole words, and regular expressions. **Esc** returns focus to the terminal.
- Right-click a tab or section heading for **Rename**, **Change tab marker**, **Restart**, **Close**, and **Export**. Terminal content retains its normal text selection and clipboard behaviour.
- **Change tab marker** adds a [Codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) before the command-status dot and tab name, with equal spacing. Quick choices are **bookmark**, **tag**, **flag**, **star**, and **ask**; **Others** opens a searchable dropdown of every icon in the bundled catalog, with icon previews. Choose one of the theme's sixteen terminal ANSI colours: active markers use the full colour, inactive markers blend 60% chosen colour with 40% original foreground. **Apply** saves, **Cancel** discards the draft, and **Remove** clears the marker. Choices are workspace-local and follow theme changes; tab-name text keeps its normal theme colour. Earlier name-colour and special-character marker preferences are discarded.
- **Cmd-click** on macOS or **Ctrl-click** elsewhere opens HTTP(S) URLs. Source locations such as `src/app.ts:12:3` open in the editor at the requested line and column; relative paths use the terminal's last known directory. Quoted paths can contain spaces. This does not resolve every tool's diagnostic format.
- Tab status dots and the footer share the same 7 px diameter and theme colour tokens: running uses `testing.iconPassed`, errors use `errorForeground`, and completion uses `terminal.ansiBlue`. The dot before each tab name shows the latest shell-reported command as running, failed (nonzero exit code), or completed (zero). Viewing the selected, visible tab clears its completed dot; another background completion shows it again. Running and error dots remain, and the footer keeps the latest result. Without a command report or notification, the tab dot is absent. Prompt text and pauses in output never count as success. Supported interactive zsh, bash, fish and PowerShell launches load the host VS Code shell integration scripts automatically when `terminal.integrated.shellIntegration.enabled` is enabled. Unsupported shells or custom launch arguments still need existing OSC 133/633 integration; explicit process exits and BEL notifications remain available. Background BEL notifications clear when selected or focused.
- Unicode 11 character-width data improves wide-character and emoji layout. The chosen font must still contain the glyphs, and newer or joined emoji sequences can have rendering limitations.

**Save** in the terminal view, or **Export** in a tab's context menu, offers **HTML**, **PDF**, **Markdown**, and **Plain text**, in that order. HTML preserves terminal colours and formatting without scripts or live links. PDF saves a real, paginated PDF using images to preserve browser-rendered fonts, colours and Unicode; its terminal text is not selectable. Markdown embeds sanitized HTML to keep colours where the reader permits inline styles; readers such as GitHub can remove those styles. Plain text removes colour formatting.

Exports capture the retained terminal buffer, not an unlimited command history. Text is limited to 1 Mi UTF-16 code units and HTML/Markdown to 8 Mi. PDF is limited to 16 MiB, 100 pages and one million terminal cells; excessive exports report an error rather than silently truncating. HTML can also be printed to PDF through a browser for selectable text, with background graphics enabled.

## Configuration

Run **Terminal Sidebar: Configure Side Bars**, or select either side bar's gear. The configuration editor in the Primary Side Bar contains independently collapsible **Primary Side Bar** and **Secondary Side Bar** groups. Folding either group keeps its unsaved edits. Each group numbers its entries from **0** and provides:

- **Name:** the initial terminal name, up to 80 characters.
- **Command:** text sent once when the terminal starts. Blank opens an interactive shell.
- **Shell:** an installed shell or executable path. Blank follows the configured VS Code shell, or the system shell when no default profile is supplied. An invalid configured executable reports an error.

Two optional fields are available in the JSON User setting: **args** is an array of literal shell arguments, and **env** is an object of environment overrides. An omitted `args` keeps the shell/default-profile arguments; `[]` clears them. `env` applies after the inherited and default-profile environment; a `null` value removes a variable. Existing values are preserved when editing Name, Command, or Shell in the visual editor.

Installed shells are detected on the machine where the extension runs. Detection checks available executables without launching them and does not change the selected shell. A custom executable path remains available when detection does not find the shell. Shell arguments do not belong in the executable field.

**Save** writes both startup lists together. **Undo** and **Redo** change the configuration draft, and **Cancel** discards its edits. **Return to terminals** keeps the draft and its undo history so you can continue editing later in the same view. These actions do not undo shell commands. A stale draft is rejected when startup settings have changed elsewhere, preserving the draft for review.

Editing startup settings leaves existing terminals running with their current launch settings. The saved changes apply on the next workspace-window startup, or when reopening a profile that is no longer open. Removing a startup entry does not stop its current terminal.

The application-scoped User setting is `terminalSidebar.sidebars`:

```json
"terminalSidebar.sidebars": {
  "left": [],
  "right": [
    { "id": "shell", "name": "Terminal", "command": "", "shell": "" },
    { "id": "neovim", "name": "Neovim", "command": "nvim", "shell": "" },
    { "id": "build", "name": "Build", "command": "", "shell": "bash", "args": ["--login"], "env": { "FOO": "bar" } }
  ]
}
```

The `left` and `right` keys refer to the Primary and Secondary Side Bars, respectively. They retain their original spelling for compatibility, regardless of where the views are positioned. The editor generates stable identifiers. Ordering and names can change without changing identity. Repository and workspace settings cannot supply startup commands. Commands execute as your user. **Commands, arguments, and environment values may all be synced**: keep credentials in the tool's own login or local credential storage, not in these fields.

## Memory and process lifetime

The extension remembers each side's open-tab order, names, selected tab, expanded sections, and next ordinary-terminal number in VS Code workspace state. After reopening the same workspace, the tabs return in their saved order on each side, including drag changes. This memory is local to the workspace window's VS Code storage and is separate from synced User settings.

When the workspace is reopened, remembered ordinary tabs return as new shells. All currently configured startup profiles also return, including those closed during the previous window; profiles absent from the remembered tabs are appended in startup-setting order. Restoring a tab creates a new process and does not replay commands typed into it. Startup commands come only from the current startup settings.

Directory restoration is best effort. The extension listens for existing OSC 7 or OSC 633 working-directory reports from the shell, including while a tab is hidden. It stores the last known local path in workspace state, never in synced startup settings. A missing directory falls back to the workspace folder or home. Supported interactive shells use the host VS Code integration scripts without changing your shell startup files; zsh uses a private temporary startup directory that forwards your original configuration. Custom command/rc-file arguments are preserved and skip automatic integration. If your shell does not emit these reports, only its launch directory is known; see [VS Code's shell integration protocol](https://code.visualstudio.com/docs/terminal/shell-integration#_supported-escape-sequences) for the supported notifications.

Typed input and terminal output are not written into layout memory. Exports happen only when requested. The extension does not create a continuous terminal log, although a shell or command-line tool may maintain its own history.

Reloading VS Code, restarting the extension host, or closing the window ends all extension terminal processes. **Restart Active Terminal** ends only the chosen terminal's process and starts it again. Closing every tab leaves that side empty for the remainder of the current window; use **+** to create another shell or **Open Profile** to reopen a startup entry.

Closing a running terminal asks for confirmation when a command is detected or its idle state cannot be established. A shell-reported idle prompt or an exited process closes directly, including ordinary text typed at a prompt but not submitted. Shell integration and available foreground-process information are advisory, not a complete process-tree detector; unsupported shells use the conservative confirmation fallback. Restarting an active process always asks for confirmation. These prompts cover extension tab controls, not VS Code window shutdown.

## Commands and portability

**Terminal Sidebar: Open Profile** opens a saved profile in the Secondary Side Bar by default. Integrations and custom keybindings can specify a side:

```json
{
  "command": "terminalSidebar.openProfile",
  "args": { "id": "neovim", "side": "right" }
}
```

The `id` refers to a startup profile in the requested side, and `side` accepts `left` or `right`. The existing command identifiers remain compatible with earlier versions.

On upgrading from 0.1 or 0.2, the old `terminalSidebar.profiles` list is read as Secondary Side Bar startup settings, and the Primary Side Bar list starts empty. No settings are rewritten during activation. The first explicit save writes the new grouped setting and retains the old value for a possible downgrade. Once the grouped setting exists, it takes precedence. A downgrade reads the retained old list; it does not include later edits made in 0.3.

Startup settings can follow **VS Code Settings Sync** when Settings sync is enabled. Shells, command-line tools, and credentials must be installed separately on each machine. Executable names are usually more portable than machine-specific paths.

In SSH, WSL, and Dev Container workspaces, detection and execution use the remote extension host. Install the extension and required tools there. Packages must match that host's operating system and architecture. Without a valid remembered directory, terminals start in the first available workspace folder, or in the user's home directory when there is no workspace folder.

## Development

Use Node.js 24 and npm:

```sh
npm ci
npm run check
```

The check runs type checking, tests, and the production build. Press **F5** to open an Extension Development Host. To package for the current platform, use the matching [VSIX target](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions). For Apple silicon:

```sh
npm run package -- --target darwin-arm64
```

Packages are stored in the repository's `release/` folder as `terminal-sidebar-<platform>-<version>.vsix`. The folder is created when needed, and CI uses the same location and naming. An explicit `--out <path>` or `-o <path>` overrides this default.

The backend includes native code. CI checks and packages macOS, Linux, and Windows independently; Marketplace publication is a separate step. Automated process and host tests do not establish that every platform's interface has been visually verified.

Project-owned identifiers use descriptive `snake_case`, with explicit processing stages and documented units and side effects. External API names and published command and setting identifiers retain their required spelling. Keep modules focused on configuration, layout memory, shell discovery, shell resolution, process lifecycle, and presentation.

The logo assets, font provenance, and regeneration instructions are described in [assets/README.md](assets/README.md).

## Contributors

- [Lu Niu (Photonico)](https://github.com/Photonico): project design and maintenance.
- **OpenAI Codex**: assistance with implementation, testing, and documentation.

Commits with Codex contributions include `Co-authored-by: Codex <codex@openai.com>`.

## Licence

[MIT](LICENSE) © 2026 Lu Niu (Photonico).

The [Codicons edit icon](https://github.com/microsoft/vscode-codicons/blob/main/src/icons/edit.svg) is Copyright Microsoft Corporation, used with its original path under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
