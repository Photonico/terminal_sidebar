# Terminal Sidebar

Terminal Sidebar brings independent terminals into the VS Code sidebars. The left side organises terminals as collapsible sections; the right side uses a compact tab strip. Each terminal runs its own shell, leaving the ordinary terminal panel available for other work.

**Version 0.5.0 is a pre-release for testing.** It requires VS Code **1.106 or later** and a desktop or remote Node.js extension host. Browser-only and virtual workspaces are unsupported.

## Getting started

1. Install **Terminal Sidebar** by **Luke Niu** (`ConAntares.terminal-sidebar`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar), choosing the pre-release version. A matching VSIX can also be installed through **Extensions: Install from VSIX…**.
2. Open **Side Term** from the Activity Bar, or **Side Terminal** in the right Secondary Side Bar.
3. Use **+** to open an ordinary shell. On the right, double-clicking blank space in the tab strip also creates a terminal.
4. Use either gear to open the configuration editor on the left. Add any terminals that should open automatically when their sidebar starts.

For example, if `grok` is already installed and signed in, add **Grok Build** as a startup name and `grok` as its command. The same arrangement applies to other command-line tools. Each tool retains responsibility for its installation, login, and credentials.

After updating the extension, reload the VS Code window to load the new code.

## Open terminals and startup settings

An **open terminal** belongs to the current workspace window. A **startup profile** describes a terminal to open when its sidebar starts. These are separate objects: closing a tab ends its process without deleting its startup profile.

The right tab strip has a **+** button to create a terminal and a **×** button to close the selected one. A middle click closes the tab beneath the pointer. Double-click blank tab-strip space to create a terminal. New ordinary shells are named **Term 0**, **Term 1**, and so on, with an independent counter on each side. Closing all ordinary tabs resets that side's counter to **Term 0**, even when startup tabs remain. Existing names are skipped.

The left sidebar presents an Explorer-style list of collapsible terminal sections. Several sections can be expanded at once and share the available height. Collapsed sections sit below them, at the bottom of the view; if all sections are collapsed, the list remains at the bottom. Collapsing a section hides its terminal and preserves the process; its close control ends the process. This layout uses a single Webview View and is not a collection of native Explorer panes.

The two sides have separate startup lists, open tabs, selections, terminal dimensions, and processes. Even terminals with the same name run independently. A command-line tool may still share its own global login or files between processes.

Each side supports up to **32 startup profiles** and **32 additional ordinary terminals**. Terminals begin when their sidebar is first used in a trusted workspace, including background startup tabs. Opening configuration alone does not run commands. Switching tabs, folding sections, or hiding a sidebar does not restart processes or repeat startup commands.

Both sides use compact 24 px headers and the VS Code interface font. Colours and corner radii come from the current theme. Terminal scrollbars use the editor's scrollbar sizes and visibility together with its normal, hover, and active slider colours. Theme and setting changes update open terminals without restarting their processes. Terminal text continues to follow the integrated-terminal font settings.

The view uses documented [Webview theme variables](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content) and public terminal APIs. It follows the host's appearance where those APIs expose it; it cannot inherit arbitrary private editor styling or guarantee pixel-identical behaviour across future VS Code releases.

## Configuration

Run **Terminal Sidebar: Configure Sidebars**, or select either sidebar's gear. The left configuration editor contains independently collapsible **Left sidebar** and **Right sidebar** groups. Folding either group keeps its unsaved edits. Each group numbers its entries from **0** and provides:

- **Name:** the initial terminal name, up to 80 characters.
- **Command:** text sent once when the terminal starts. Blank opens an interactive shell.
- **Shell:** an installed shell or executable path. Blank follows the configured VS Code shell, or the system shell when no default profile is supplied. An invalid configured executable reports an error.

Installed shells are detected on the machine where the extension runs. Detection checks available executables without launching them and does not change the selected shell. A custom executable path remains available when detection does not find the shell. Shell arguments do not belong in the executable field.

**Save** writes both startup lists together. **Undo** and **Redo** change the configuration draft, and **Cancel** discards its edits. These actions do not undo shell commands. A stale draft is rejected when startup settings have changed elsewhere, preserving the draft for review.

Editing startup settings leaves existing terminals running with their current launch settings. The saved changes apply on the next workspace-window startup, or when reopening a profile that is no longer open. Removing a startup entry does not stop its current terminal.

The application-scoped User setting is `terminalSidebar.sidebars`:

```json
"terminalSidebar.sidebars": {
  "left": [],
  "right": [
    { "id": "shell", "name": "Terminal", "command": "", "shell": "" },
    { "id": "grok", "name": "Grok Build", "command": "grok", "shell": "" }
  ]
}
```

The editor generates stable identifiers. Ordering and names can change without changing identity. Repository and workspace settings cannot supply startup commands. Commands execute as your user: keep credentials in the command-line tool's own login or local credential storage, since startup settings may be synced.

## Memory and process lifetime

The extension remembers each side's open-tab order, names, selected tab, expanded sections, and next ordinary-terminal number in VS Code workspace state. This memory is local to the workspace window's VS Code storage and is separate from synced User settings.

When the workspace is reopened, remembered ordinary tabs return as new shells. All currently configured startup profiles also return, including those closed during the previous window. Restoring a tab creates a new process; it does not resume a previous shell, restore its working directory, or replay commands typed into it. Startup commands come only from the current startup settings.

Typed input and terminal output are not written into layout memory. **Save** while a terminal is selected explicitly exports its displayed plain text to a chosen file. The extension does not create a continuous terminal log, although a shell or command-line tool may maintain its own history.

Reloading VS Code, restarting the extension host, or closing the window ends all extension terminal processes. **Restart Active Terminal** ends only the chosen terminal's process and starts it again. Closing every tab leaves that side empty for the remainder of the current window; use **+** to create another shell or **Open Profile** to reopen a startup entry.

## Commands and portability

**Terminal Sidebar: Open Profile** opens a saved profile on the right by default. Integrations and custom keybindings can specify a side:

```json
{
  "command": "terminalSidebar.openProfile",
  "args": { "id": "grok", "side": "right" }
}
```

The `id` refers to a startup profile in the requested side, and `side` accepts `left` or `right`. The existing command identifiers remain compatible with earlier versions.

On upgrading from 0.1 or 0.2, the old `terminalSidebar.profiles` list is read as right-side startup settings, and the left list starts empty. No settings are rewritten during activation. The first explicit save writes the new grouped setting and retains the old value for a possible downgrade. Once the grouped setting exists, it takes precedence. A downgrade reads the retained old list; it does not include later edits made in 0.3.

Startup settings can follow **VS Code Settings Sync** when Settings sync is enabled. Shells, command-line tools, and credentials must be installed separately on each machine. Executable names are usually more portable than machine-specific paths.

In SSH, WSL, and Dev Container workspaces, detection and execution use the remote extension host. Install the extension and required tools there. Packages must match that host's operating system and architecture. Terminals start in the first available workspace folder, or in the user's home directory when there is no workspace folder.

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

## Licence

[MIT](LICENSE) © 2026 Lu Niu (Photonico).
