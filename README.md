# Terminal Sidebar

Terminal Sidebar brings independent terminal sessions into the VS Code sidebar. Each profile defines a name, a startup command, and an optional shell. The extension starts that shell and keeps its session available while you work elsewhere in the editor. This gives command-line tools a consistent place beside the editor, while preserving the ordinary terminal panel.

**Version 0.2.0 is a pre-release for testing.** It requires VS Code **1.106 or later** and a desktop or remote Node.js extension host. Browser-only and virtual workspaces are unsupported.

## Getting started

1. Install **Terminal Sidebar** by **Luke Niu** (`ConAntares.terminal-sidebar`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar), choosing the pre-release version. A matching VSIX can also be installed through **Extensions: Install from VSIX…**.
2. Run **Terminal Sidebar: Configure Sidebars**, or select the gear in either sidebar. The configuration editor opens on the left.
3. Add a profile, enter its name and startup command, and choose a shell if needed. Save the configuration.
4. Select the profile in **Side Term** to start its terminal. The workspace must be trusted.

For example, if `grok` is already installed and signed in, enter **Grok** as the name and `grok` as the command. The same arrangement applies to other command-line tools. Each tool retains responsibility for its installation, login, and credentials.

After upgrading an existing installation, reload the VS Code window to load the new extension code.

## Profiles and shells

The configuration editor manages up to **32 profiles**, numbered from **#0**. Each profile contains:

- **Name:** the displayed tab name, up to 80 characters.
- **Command:** text sent once when the terminal starts. Leave it blank for an interactive shell.
- **Shell:** an installed shell or an executable path. Leave it at the default to follow the configured VS Code shell, with a system-shell fallback.

The shell list is detected on the machine where the extension runs. Detection checks available executables without launching them or requesting their versions. It does not change your selection. Choose **Custom** for an executable that is absent from the list; shell arguments do not belong in this field.

Profiles are stored in the application-scoped User setting `terminalSidebar.profiles`. The editor creates a stable identifier for each profile. The same setting can be edited through **Preferences: Open User Settings (JSON)**:

```json
"terminalSidebar.profiles": [
  { "id": "shell", "name": "Terminal", "command": "", "shell": "" },
  { "id": "grok", "name": "Grok", "command": "grok", "shell": "" }
]
```

Commands execute as your user. Keep credentials in the command-line tool's own login or local credential storage, since profile settings may be synced. Repository and workspace settings cannot supply these profiles.

## Choosing a sidebar

**Side Term** is available in the Activity Bar for the left sidebar and in the right Secondary Side Bar. Both views use compact, named profile tabs. Select a profile independently on either side; opening the same profile in both views shares one terminal process. The focused view determines its terminal dimensions.

The outer **Side Term** title remains fixed. VS Code's stable extension API does not provide arbitrary, dynamically named sidebar containers or Command Palette entries for user profiles. Use **Terminal Sidebar: Open Profile** to choose a saved profile. Integrations can also open a profile through the generic command with its identifier and preferred side.

For a custom keybinding, use this command and argument pair with a key of your choice:

```json
{
  "command": "terminalSidebar.openProfile",
  "args": { "id": "grok", "side": "right" }
}
```

Here, `id` refers to the saved profile, and `side` accepts `left` or `right`. Omitting the side opens the profile on the right.

Each view provides a gear for configuration and controls for saving, undoing, redoing, and closing:

- **Save** writes the configuration draft, or exports the terminal's displayed plain text when a terminal is active.
- **Undo** and **Redo** apply to configuration edits. They do not reverse shell commands.
- **Close** discards an open configuration draft, or stops the active terminal. It does not delete the profile.

The configuration editor checks for changes made elsewhere before saving, so a stale draft cannot silently overwrite newer settings.

## Session behaviour

Each profile starts when selected. Switching tabs or hiding a sidebar keeps the process alive. **Restart Active Terminal** ends that process and starts a fresh one. Changes to its command or shell take effect on the next restart.

Removing a profile stops its terminal. Reloading VS Code, restarting the extension host, or closing the window ends all extension terminal processes. They are not restored after reload.

Terminal output is held in memory for the current session. Saving a terminal exports its displayed text; it does not create a continuous log. A shell or command-line tool may maintain its own history and files.

Terminals start in the first available workspace folder, or in the user's home directory when no workspace folder is available. Workspace Trust blocks execution until the workspace is trusted.

## Settings and portability

Profiles can follow **VS Code Settings Sync** when Settings sync is enabled. Shells, command-line tools, and their login credentials must be set up separately on each machine. Executable names are more portable than machine-specific paths, provided that the corresponding program is installed.

In SSH, WSL, and Dev Container workspaces, the extension runs on the remote extension host. Shell detection and terminal execution therefore use that host. Install the extension and the required tools there, and choose a VSIX matching its operating system and architecture.

## Development

Use Node.js 24 and npm:

```sh
npm ci
npm run check
```

The check runs type checking, tests, and the production build. Press **F5** in VS Code to open an Extension Development Host. To package the current machine's build, use the matching [VSIX target](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions). For Apple silicon:

```sh
npm run package -- --target darwin-arm64
```

The terminal backend includes native code, so each package must be built on its matching operating system and architecture. CI runs checks and prepares packages on macOS, Ubuntu, and Windows. The VSIX target follows each runner's actual platform and architecture. Workflow artifacts are available for inspection; Marketplace publication is separate. These automated checks do not establish that the VS Code interface has been visually tested on every platform.

The logo assets, font provenance, and regeneration instructions are described in [assets/README.md](assets/README.md).

## Licence

[MIT](LICENSE) © 2026 Lu Niu (Photonico).
