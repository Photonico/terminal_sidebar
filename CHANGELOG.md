# Changelog

## 0.10.0 — Pre-release

- Simplify the marker color heading and add active/inactive tab foreground colors in a new palette column.
- Remember startup-profile and document markers across workspaces, including explicit removal.
- Preview PDF, Markdown, and compiled LaTeX PDFs inside either side bar; remember reading positions and refresh after file saves. Scroll continuously through PDFs with a document-wide scrollbar and on-demand rendering. Add contents navigation, single/two-page layouts, circular zoom controls, modifier-wheel zoom, and dark reading.
- Preview static HTML with local assets and formatted CSS, JSON, and JSONC source; keep scripts and forms inactive, preserve source files, and reuse bounded reads and file watching.
- Render Markdown math with KaTeX, task lists, and footnotes. Add a preview font selector with a Default option and a User setting that follows Settings Sync.
- Search complete PDF, Markdown, HTML, and formatted-source documents with highlighted matches, navigation, case, whole-word, and regular-expression options.
- Search all open tabs across both sidebars, with direct result navigation. Move Preview in Sidebar Terminal to the editor title toolbar.
- Double-click PDF text to locate its LaTeX source in the main editor with SyncTeX.
- Shorten the README and add Chinese and Japanese introductions.
- Unify toolbar badge alignment, rounded controls, circular zoom buttons, and footer spacing. Keep supported formats consistent across editor menus, file selection, and document links.
- Share scrolling, zoom, and heading-outline controls across text previews; remove redundant preview captions and add action tooltips.
- Simplify parent toolbars and child New/Search/Close controls; add button context menus, document copying, and an About page.
- Add an offline English/Chinese/Japanese Usage page, an anchored Markdown font menu with synced preferences, and a vertical document outline.
- Float status badges at the lower left of both sidebars, with matching spacing and clearance for terminal input.

## 0.8.0 — Pre-release

- Search retained output in a VS Code-style find overlay with platform-default Find shortcuts.
- Add tab context menus, inline renaming, and confirmation before closing a terminal whose command may still be running.
- Unify tab and footer status dots; load host shell integration for supported interactive launches so idle-close detection and running/completed/error indicators receive real command events. Preserve custom launch arguments and shell startup files.
- Use consistent spacing between custom markers, status dots, and tab names; enlarge tab and footer status dots to 7 px. Dismiss a completion once viewed while retaining later command notifications.
- Add Codicon tab markers with five quick choices and a searchable full-catalog dropdown. Apply theme colours to markers at full intensity when active or a 60% blend when inactive; remove earlier name-colour and character-marker preferences.
- Export HTML, real raster PDF, Markdown with embedded HTML, or plain text.
- Open web links and source-file locations with Cmd-click / Ctrl-click; improve character widths with Unicode 11 data.
- Remember directories reported by existing shell integration, with workspace/home fallback when a saved directory is unavailable.
- Support literal shell arguments and environment overrides in startup profile JSON, preserving them in the visual editor.
- Add CI, Marketplace, install-count, and licence badges to the README.
- Make marker migration tests use native paths and catalog validation accept Windows checkout line endings.

## 0.7.0 — Pre-release

- Rename terminals from the edit button beside each sidebar's close button; preserve renamed tabs in the saved layout.
- Use **Side Terminals** for both view titles and clarify the buttons that open the opposite sidebar's terminals.
- Unify themed tab colours and compact circular action buttons; connect the Primary Side Bar's active, expanded tab background to its terminal.
- Add **Return to terminals** to startup configuration, preserving unsaved drafts and undo history for continued editing.
- Place startup profile titles and their actions on one line, use the same close icon as terminal tabs, and make shell detection and profile actions circular.
- Improve configuration text readability, balanced spacing, and field alignment as the font size changes.

## 0.6.0 — Pre-release

- Use the official Primary Side Bar and Secondary Side Bar names while preserving existing command identifiers and settings keys.
- Add **+** to the Secondary Side Bar's title toolbar. In both title toolbars, place **Open Secondary Terminal** or **Open Primary Terminal** immediately after **+**, using circled right or left arrows, respectively.
- Add a button in each empty state to open and focus the other Side Terminal view, including when it is hidden.

## 0.5.0 — Pre-release

- Reorder tabs by dragging or keyboard; restore each sidebar's saved order.
- Preserve section order when expanding or collapsing, with consistent headers and a status badge.
- Match left tab selection and hover colours to editor tabs; adapt empty views and footer backgrounds to the theme.
- Place empty-state guidance at the top with more space around the message.
- Theme-based scrollbars, rounded controls, and collapsible startup groups.
- Reset numbering after all ordinary tabs close.
- Unify Side Terminal naming; refine the logo and Activity Bar icon.
- Store platform VSIX packages in `release/`.

## 0.3.0 — Pre-release

- Independent sidebars, collapsible left sections, and compact right tabs.
- Add and close runtime tabs without changing startup profiles.
- Remember tab layouts without saving terminal input or output.
- Update the logo; preserve legacy profiles and commands.
- Adopt descriptive `snake_case` throughout project code.

## 0.2.0 — Pre-release

- Add the left Activity Bar view with shared terminal sessions.
- Compact tabs, shell detection, and custom shells.
- Configuration undo/redo, conflict checks, and terminal export.
- Profile picker and commands for either sidebar.

## 0.1.0

- Right sidebar terminals, named tabs, and startup configuration.
- Settings Sync support; CLI-managed credentials.
- Photonico Code logo and MIT licence.
