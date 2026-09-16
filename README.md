# Terminal sidebar

A VS Code extension for independent sidebar terminals. Give each terminal a name, a startup command, and an optional shell. Use it for Grok or any other installed command-line tool.

The extension adds one **Terminal Sidebar** container beside Chat and Codex in the Secondary Side Bar. Your profiles appear as named tabs **inside** that container. VS Code's stable extension API does not provide arbitrary, dynamically named top-level sidebar containers.

Requires VS Code **1.106 or later**, when [Secondary Side Bar contributions became stable](https://code.visualstudio.com/updates/v1_106#_view-containers-in-secondary-side-bar), and a desktop or remote Node.js extension host. Browser-only and virtual workspaces are unsupported.

## Quick start

1. Install **Terminal Sidebar** by **Luke Niu** (`ConAntares.terminal-sidebar`) from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ConAntares.terminal-sidebar). For a local build, install the matching VSIX using **Extensions: Install from VSIX…**. For development, run `npm ci` in this repository, open it in VS Code, and press **F5**.
2. Run **Terminal Sidebar: Configure Sidebars** from the Command Palette.
3. Add profiles, enter a tab name and startup command, then save. Leave the shell blank to use your configured VS Code default shell when available, with a system-shell fallback.
4. Open a profile tab to start its terminal. Terminals run only in trusted workspaces.

For example, if a CLI named `grok` is already installed and signed in, use **Grok** as the name and `grok` as the command. Substitute the actual command for the CLI you use. The extension does not install CLIs, implement OAuth, or provide a model-provider API integration.

## Profiles

The visual editor manages up to **32 profiles**, numbered from **#0**. Profiles are stored in the application-scoped User setting `terminalSidebar.profiles`; you can also edit it in **Preferences: Open User Settings (JSON)**:

```json
"terminalSidebar.profiles": [
  { "id": "shell", "name": "Terminal", "command": "", "shell": "" },
  { "id": "grok", "name": "Grok", "command": "grok", "shell": "" },
  { "id": "bash", "name": "Bash", "command": "", "shell": "bash" }
]
```

- `id`: a stable, unique identifier using letters, numbers, underscores, or hyphens. The visual editor creates it automatically.
- `name`: the displayed tab name, up to 80 characters.
- `command`: text sent to the shell once when the terminal starts. Blank opens an interactive shell.
- `shell`: an installed executable name such as `powershell`, `cmd`, `bash`, `zsh`, or `fish`, or a full executable path. Leave it blank for the default; do not put command-line arguments here.

Commands execute as your user. Keep passwords and API keys out of profile settings and startup commands; use the CLI's own login or local credential storage. Repository/workspace settings cannot supply these profiles, and Workspace Trust blocks terminal execution until the workspace is trusted.

## Terminal behavior

- Each profile has its own shell process and starts when selected. Switching tabs or hiding the sidebar keeps running processes alive.
- **Restart Active Terminal** ends the current process and starts a fresh one. Changes to a running profile's command or shell take effect on its next restart.
- Removing a profile stops its terminal. Reloading the VS Code window, restarting the extension host, or closing the window ends its terminal processes.
- Terminal output is held in memory for the current session. The extension does not persist logs or transcripts or restore processes after reload; the selected tab and profile settings can be remembered. A shell or CLI may maintain its own history and files.
- Terminals start in the first available workspace folder, or the user's home directory when no workspace folder is available.

## Across machines and remote workspaces

Profile settings can follow **VS Code Settings Sync** when Settings sync is enabled. Shells, CLIs, their installations, and their login credentials must be set up separately on each machine. Choose commands and executable names available on the destination; machine-specific paths may need adjustment.

In SSH, WSL, or Dev Container workspaces, the extension runs on the **remote extension host**. Install the extension and required shell/CLI there, and choose a VSIX matching that host rather than the computer displaying VS Code.

## Development and packaging

Use Node.js 24 and npm:

```sh
npm ci
npm run check
```

`check` runs type checking, tests, and the production build. Press **F5** in VS Code to open the Extension Development Host. To create a package for the current machine, use its matching [VSIX target](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions), for example on Apple silicon:

```sh
npm run package -- --target darwin-arm64
```

The terminal backend includes native code, so package on the matching operating system and architecture. CI checks and packages macOS, Ubuntu, and Windows builds, derives each VSIX target from the runner's actual platform and architecture, and uploads the VSIX as a workflow artifact. It does not publish to the Marketplace. Cross-platform CI is distinct from checking the terminal UI in VS Code on each platform.

## Logo

The vector and PNG logo assets, their font provenance, and regeneration instructions are documented in [assets/README.md](assets/README.md).

## License

[MIT](LICENSE) © 2026 Lu Niu (Photonico).
