# Terminal Sidebar 0.3

Status: implementation specification. Runtime tab behaviour below supersedes the original first-expansion startup proposal.

Version 0.3 separates the two sidebars. The left sidebar presents named terminal sections that expand vertically, following the organisation of Explorer. The right sidebar retains compact horizontal tabs. Each side has its own profiles and terminal processes.

## Code style

The reference is Photonico's [vmatplot source](https://github.com/Photonico/H-Beryllene_20250718/tree/f863ab02ebf93d5804f5552967ea750571778335/vmatplot), inspected at revision `f863ab02ebf93d5804f5552967ea750571778335`.

Use readable names and explicit processing stages so that the code remains straightforward to inspect and maintain:

- Use descriptive `snake_case` for identifiers owned by this extension. Prefer `active_profile_id`, `pending_output`, `discover_shells`, and `save_in_progress` to abbreviated or compressed names.
- Make data shape and units visible where they matter: `profile_list`, `environment_variables`, `column_count`, `row_count`, and `discovery_timeout_ms`.
- Expand one-line branches, nested conditional expressions, and lifecycle callbacks when this makes the processing order easier to follow. Introduce intermediate values when they explain a decision.
- Document significant parameters, defaults, return values, units, and side effects. State whether an operation starts a process, changes settings, or only changes presentation.
- Use short comments to explain stages and invariants. Avoid comments that merely repeat an assignment.
- Keep modules organised around actual tasks: configuration, shell discovery, shell resolution, session lifecycle, and presentation. Retain existing classes where they already help; avoid adding a framework solely for this refactor.
- Apply the same conventions to tests and build scripts. Generated bundles and dependency code are outside the style refactor.

External contracts retain their required names. Examples include VS Code's `resolveWebviewView`, xterm's `fontFamily`, and node-pty's `onData`, `cols`, `cwd`, and `env`. Map descriptive internal values to these fields explicitly. Published command identifiers, view identifiers, and existing settings identifiers also remain compatible; a naming change must not break saved shortcuts or synced configuration.

The style refactor is a separate change from the new behaviour. Existing tests must still pass before the independent sidebars are introduced.

## Left sidebar

The Activity Bar continues to open the extension's left sidebar. Its terminal area becomes a vertical list of collapsible sections:

```text
> Terminal
v Grok Build
  [interactive terminal]
> Development server
```

Each heading displays the configured name. Expanding a section reveals its terminal directly beneath that heading; several sections may be open at once. Long names truncate with the full name available on hover. Headings provide keyboard focus and an announced expanded state.

Use one Webview View containing these sections. This is an Explorer-style arrangement, rather than a collection of native Explorer panes. A native Tree View cannot contain an interactive xterm surface. Predeclaring many native Webview Views would introduce fixed slots and additional title and layout state; it is unnecessary for the requested arrangement.

Configured startup tabs open when their sidebar is first used in a trusted workspace, including collapsed sections and background tabs. Opening configuration alone does not launch commands. Collapsing preserves the process and output; expanding again does not resend the startup command.

Expanded sections share the available height, with a minimum usable terminal height and vertical scrolling when necessary. Only visible terminal surfaces are fitted; a collapsed or hidden surface must not resize its process to zero columns or rows. Closing a terminal stops that section's process and leaves its profile available for an explicit restart.

The gear opens the shared configuration editor on the left. Entering or leaving configuration does not stop running terminals.

## Independent configuration and sessions

The configuration editor contains two groups, with numbering starting at zero in each group:

```text
Left sidebar
  Left sidebar #0   [Name] [Command] [Shell]
  Left sidebar #1   [Name] [Command] [Shell]

Right sidebar
  Right sidebar #0  [Name] [Command] [Shell]
  Right sidebar #1  [Name] [Command] [Shell]
```

Each side supports up to 32 profiles. Adding, removing, renaming, or reordering a profile applies only to its group. Both groups retain shell discovery, a blank default shell, editable command fields, and configuration undo and redo. Saving writes the complete draft once; a stale draft is rejected without losing its edits.

Store both lists in one application-scoped User setting so that a save cannot leave one list updated and the other list unchanged:

```json
"terminalSidebar.sidebars": {
  "left": [],
  "right": [
    { "id": "default", "name": "Terminal", "command": "", "shell": "" }
  ]
}
```

Use a separate session manager for each side. Terminal identity is the combination of side and stable profile identifier. Names are presentation; array positions are ordering. The same identifier or name may appear on both sides without linking their processes.

Output, input, dimensions, selection, restart, close, and removal stay within the originating side. A left-side action must not resize or stop a right-side process. Message routing derives the side from the registered host view, rather than trusting an arbitrary side supplied by a webview message. Shell discovery and appearance resolution may share read-only results.

Independence applies to the extension's configuration and terminal sessions. A command-line tool may still use its own global login, files, and service account across multiple processes; the extension does not create separate operating-system sandboxes or credentials.

## Right sidebar appearance

Change the right native container's visible title from **Side Term** to **Side Terminal**. Preserve its existing identifier so that shortcuts and view placement continue to work. The extension's Marketplace name remains **Terminal Sidebar**.

The initial dimensions for the inner profile tabs are:

- Height: **24 px**, reduced from 26 px.
- Horizontal padding: **6 px** per side, reduced from 8 px.
- Font size: retain the current 12 px unless host font scaling requires adjustment.
- Corner radius: `var(--vscode-cornerRadius-small, 4px)`.

The selected tab has rounded upper corners and square lower corners. It uses the same resolved background colour as the terminal surface below it. Remove the decorative line beneath the tab strip and the selected tab's underline, so the two backgrounds meet continuously.

An unselected tab under the pointer uses the theme's hover colour and rounded corners on all four sides. Its coloured rectangle is smaller than the selected tab: inset the hover background by **2 px on each side**, giving an initial background height of **20 px** inside the 24 px tab. Keep the same corner-radius value. Draw this inset on a separate background layer; do not change the label position, tab width, or full clickable area on hover.

Hovering over the selected tab preserves its full-size connected shape. Keyboard focus remains visible around the complete clickable tab; high-contrast accessibility outlines are retained without restoring a permanent decorative underline.

Resolve the tab and xterm backgrounds from the same theme value, including the same fallback. Theme changes update both together. The current VS Code workbench supplies the small corner-radius variable to webviews and uses it for its modern sidebar tabs. Older supported versions use the 4 px fallback, so exact geometry cannot be guaranteed on every older workbench.

## Migration from 0.2

1. If the new setting exists, validate and use it. An explicitly empty startup group remains empty; remembered runtime shells may still be restored. Invalid new configuration reports an error and retains the last valid state; it must not silently fall back to old commands.
2. If only `terminalSidebar.profiles` exists, read it as the right-side list. Start the left list empty. Preserve profile identifiers, names, command text, shell selections, and ordering.
3. Do not write settings during activation or start terminals merely to migrate configuration. The first explicit configuration save writes the new object. Keep the legacy value for an explicit downgrade; once the new setting exists, it is inactive.
4. A new installation starts with one ordinary shell profile on the right and an empty left group. Reading defaults must not accidentally hide a user's legacy setting; inspect the explicit User value before applying defaults.
5. Keep `terminalSidebar.openProfile` and its `{ "id": "...", "side": "left" | "right" }` argument form. An omitted side continues to mean right. Resolve a profile only within the requested side.

User settings can continue through VS Code Settings Sync. Running processes and output stay in memory. Tab descriptors, selection, and expanded-section state are remembered in workspace-local VS Code storage. Installed shells and CLI credentials remain managed on each execution host. Downgrading to 0.2 reads the retained old configuration; new 0.3 edits are not silently written back to that legacy setting.

## Implementation and acceptance

Implement the work in separate reviewable stages:

1. Refactor owned names, processing blocks, and documentation without changing behaviour.
2. Add the grouped configuration model, migration reader, and independent session ownership.
3. Build the left accordion and grouped configuration editor, then apply the right-tab styling.
4. Verify behaviour, package 0.3.0 as a testing pre-release, and publish after implementation is complete.

Acceptance checks must cover observable behaviour:

- Existing configuration opens on the right with no duplicate startup commands or automatic settings writes.
- Two profiles with the same identifier on opposite sides create separate processes. Input, output, resize, restart, close, and deletion never cross sides.
- Reordering and renaming retain the correct process. Collapsing and reopening a left section preserve its session; multiple visible sections receive their own dimensions.
- Empty groups, invalid configuration, Settings Sync changes during editing, cancellation, and undo/redo preserve the user's intended configuration.
- Shell discovery still leaves the default and custom executable selections intact.
- Light, dark, and high-contrast themes show the selected tab joined to its terminal. The unselected hover background is visibly smaller without moving text or changing the hit area. Focus, long names, narrow widths, and window scaling remain usable.
- The existing process cleanup and Workspace Trust checks pass on macOS, Windows, and Linux. Native VS Code tests confirm view registration and commands; visual checks establish layout separately.

## Runtime tabs added to the scope

Startup definitions and current tabs are separate. The right strip provides + and ×; blank-space double click adds an ordinary tab, and middle click closes the targeted tab. Closing never deletes startup settings. New tabs use the default shell and names Term 0, Term 1, and so on, independently on each side.

Workspace memory stores tab identifiers, names, order, selection, expanded sections, and the next number. It excludes shell input, terminal output, credentials, and startup command copies. On a new window, restore ordinary tabs as fresh shells and reopen all currently configured startup profiles. Existing open tabs retain their launch settings when startup configuration changes.

## References

- [vmatplot algorithms](https://github.com/Photonico/H-Beryllene_20250718/blob/f863ab02ebf93d5804f5552967ea750571778335/vmatplot/algorithms.py): descriptive intermediate values, units, and explicit processing stages.
- [vmatplot output settings](https://github.com/Photonico/H-Beryllene_20250718/blob/f863ab02ebf93d5804f5552967ea750571778335/vmatplot/output_settings.py): practical defaults and documented parameter groups.
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view): tree items and contributed views.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview): interactive view contents, theme variables, and lifecycle.
- [VS Code webview theme data](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/webview/browser/themeing.ts) and [base sizes](https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/common/sizes/baseSizes.ts): workbench size variables and the small corner-radius default. These upstream implementation links describe the inspected current behaviour, rather than a promise about older versions.
